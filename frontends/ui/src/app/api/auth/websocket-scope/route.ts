/**
 * Internal WebSocket Collection Scope Endpoint
 *
 * Called by server.js during the WebSocket upgrade handshake. It resolves the
 * current Grid session from the encrypted WorkOS cookie, builds the ordered
 * collection scope, and returns the base64url-encoded header value.
 *
 * Gate THEN fan-out. Phase 1 is serial: the session, the collection scope,
 * the reflection flag, the org-level cached reads, and the budget status —
 * each step can refuse the upgrade or is needed by the gate, so they run
 * alone and in order. A blocked budget returns 403 BEFORE any project-expensive
 * lookup fires. Phase 2 fans out to at most 4 concurrent lookups (prompt view,
 * Bundesland, memory digest, decisions scan). Each keeps the failure posture
 * it had: the ones that were best-effort still degrade to "absent" with a
 * warning, the prompt-view denial still fails the upgrade with 403, and any
 * other prompt-view failure still propagates to the 500 handler.
 *
 * Every project-scoped lookup uses the EFFECTIVE project id (the authorized
 * scope's project, falling back to the query param) — never the raw query
 * param — so an implicit project from the stored active-project preference is
 * not silently dropped from budget, prompt, Bundesland, memory or decisions.
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { getGridSession } from '@/lib/auth/session'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProposalDecisionsBlock, composeMemoryContext } from '@/lib/projects/proposal-decisions'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { isMemoryReflectionEnabled } from '@/lib/workos/feature-flags'
import { isWebSearchEnabledForOrg } from '@/lib/organizations/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { getBudgetStatus } from '@/lib/budgets/service'
import { isAuthzError } from '@/lib/auth-utils'
import { isAuthRequired } from '@/lib/backend-proxy'

/** Run a best-effort lookup: its failure is logged and read as "absent". */
async function bestEffort<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    console.warn(`[WebSocket Scope API] Failed to ${what}:`, error)
    return null
  }
}

export const GET = tenantSlotRoute(async function GET(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId') || undefined
    const conversationId = searchParams.get('conversationId') || undefined

    const session = await getGridSession()

    if (isAuthRequired() && !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { scope, scopedCollections, headerValue, projectId: authorizedProjectId } =
      await buildCollectionScopeFromRequest(session, {
        projectId,
        conversationId,
      })

    const response: Record<string, unknown> = {
      scope,
      // `server.js` signs these into the request-context envelope, which is the
      // copy `scoping.py` trusts for an authenticated turn. `scope` stays as the
      // bare-name list existing clients read (ADR-0047).
      scopedCollections,
      header: headerValue,
    }

    if (session) {
      response.organizationId = session.organizationId
      response.userId = session.userId
      response.accessToken = session.accessToken
    }

    const organizationId = session?.organizationId

    // The project every lookup below is scoped to: the authorized scope's
    // project (explicit query param as authorized, or the stored implicit
    // project) with the raw query param as fallback. Using the query param
    // directly dropped the implicit project from every lookup after the scope.
    const effectiveProjectId = authorizedProjectId ?? projectId

    // Phase 1 — serial gates. Session and scope already ran above; then the
    // reflection flag and the budget status, in that order. They stay serial
    // so a refusal returns BEFORE anything else fires — and so the post-gate
    // fan-out below is bounded at 4 concurrent lookups (pool impact: at most
    // 4 pool users after the gate, each a bounded query or cached read).
    //
    // Gate the async memory-reflection stage: with WorkOS flag enforcement
    // on, the per-org "memory-reflection" flag is the source of truth; without
    // enforcement it follows GRID_MEMORY_REFLECTION_ENABLED (default on) — see
    // isMemoryReflectionEnabled. server.js forwards this as
    // x-grid-feature-memory-reflection.
    const memoryReflectionEnabled = await isMemoryReflectionEnabled(organizationId)
    // Budget enforcement (ADR-0015): refuse the upgrade outright when a
    // budget scope is already exhausted, otherwise forward the remaining
    // budget so the backend tracker can stop a runaway turn mid-flight.
    // Fails OPEN on read errors — a broken budget lookup must not take
    // chat down; enforcement resumes on the next healthy upgrade.
    const budgetStatus =
      organizationId && session
        ? await bestEffort('compute budget status', () =>
            getBudgetStatus(organizationId, session.userId, effectiveProjectId ?? null)
          )
        : null

    if (budgetStatus?.blocked) {
      return NextResponse.json(
        {
          error: 'Budget exhausted',
          reason: `The ${budgetStatus.blockedScope} LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.`,
        },
        { status: 403 }
      )
    }

    // Still serial, but AFTER the gate: the org-level cached reads (30s/5min
    // TTLs, near-always hits) the success response carries. They run here —
    // not in the fan-out — so Phase 2 stays exactly the four project lookups.
    // Org-level web-search setting (ADR-0022): when off, server.js forwards
    // x-grid-disabled-sources and the backend subtracts the source from
    // every tool selection — enforcement, not just UI hiding. Best-effort:
    // a lookup failure must not take chat down (web search stays on).
    const webSearchEnabled = organizationId
      ? await bestEffort('resolve web-search setting', () => isWebSearchEnabledForOrg(organizationId))
      : null
    // Effective runtime model selection — the platform defaults
    // (`platform_model_defaults`) with the org's own active
    // org_model_configs version layered on top — forwarded by server.js as
    // x-grid-model-overrides. Best-effort: a config read failure must not
    // block chat; the workflow YAML models apply instead.
    const modelOverrides = organizationId
      ? await bestEffort('load model overrides', () => getEffectiveModelOverrides(organizationId))
      : null

    // Phase 2 — the remaining independent lookups, fanned out. Access is
    // already enforced: buildCollectionScopeFromRequest ran
    // requireProjectAccess for this exact (session, projectId) under the
    // same auth-required condition, so re-checking here only repeated the
    // tenancy query and FGA round-trips.
    // Residual exposure: when REQUIRE_AUTH is off (anonymous single-tenant
    // deployments) there is no session, so the caller-supplied projectId
    // reaches loadProjectPromptView and the memory digest unchecked. The
    // service layer pins queries to session.organizationId whenever a
    // session exists (defense-in-depth); fully gating anonymous mode is a
    // product decision.
    //
    // Error precedence: the budget gate above already decided. A prompt-view
    // AuthzError still refuses the upgrade (403) but is stashed — not thrown —
    // so it cannot reject the whole fan-out; any OTHER prompt-view failure
    // keeps today's posture and propagates to the 500 handler. Everything
    // else fails open to "absent", as today.
    let promptViewAuthzError: unknown = null
    const [projectContext, bundesland, memoryDigest, decisions] = await Promise.all([
      // Structured project facts for the envelope's `projectContext` field.
      effectiveProjectId
        ? loadProjectPromptView(effectiveProjectId, organizationId).catch((error: unknown) => {
            if (isAuthzError(error)) {
              promptViewAuthzError = error
              return null
            }
            throw error
          })
        : Promise.resolve(null),
      // Structured jurisdiction fact (backlog T3-9 follow-up, 2026-07-16,
      // user-mandated) — becomes the envelope's `bundesland` field on the WS
      // upgrade (server.js), a parallel channel alongside the unchanged
      // `bundesland=<token>` line already inside `projectContext` above.
      // Best-effort: a lookup failure must not block the chat handshake, it
      // just means the backend falls back to prompt-text parsing.
      effectiveProjectId
        ? bestEffort('load bundesland fact', () =>
            loadProjectBundesland(effectiveProjectId, organizationId)
          )
        : Promise.resolve(null),
      // Core memory digest (bounded) — becomes x-grid-project-memory on the WS
      // upgrade. Merges project items with org-wide items; org knowledge applies
      // even outside a project-scoped chat. Best-effort: memory must
      // never block the chat handshake, and a failed digest drops the whole
      // block, as it always did.
      bestEffort('build project memory digest', () =>
        buildProjectMemoryDigest(effectiveProjectId, organizationId ?? undefined)
      ),
      // What the project decided about earlier proposals rides the memory
      // channel. Best-effort: a scan failure drops the block, never the handshake.
      effectiveProjectId && organizationId
        ? buildProposalDecisionsBlock(effectiveProjectId, organizationId).catch(() => null)
        : Promise.resolve(null),
    ])
    if (promptViewAuthzError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const projectMemory = composeMemoryContext(memoryDigest, decisions)

    response.memoryReflectionEnabled = memoryReflectionEnabled

    if (organizationId) {
      if (webSearchEnabled === false) {
        response.disabledSources = ['web_search']
      }
      if (modelOverrides) {
        response.modelOverrides = modelOverrides
      }
      // A blocked budget already returned 403 at the gate above; here the
      // status only rides along so the backend tracker can stop a runaway
      // turn mid-flight.
      if (budgetStatus) {
        response.budget = {
          remainingOrgUsd: budgetStatus.remainingOrgUsd,
          remainingUserUsd: budgetStatus.remainingUserUsd,
          remainingProjectUsd: budgetStatus.remainingProjectUsd,
          remainingOrgTokens: budgetStatus.remainingOrgTokens,
          remainingUserTokens: budgetStatus.remainingUserTokens,
          remainingProjectTokens: budgetStatus.remainingProjectTokens,
        }
      }
    }

    // Echo the EFFECTIVE project: with an implicit project the query param is
    // empty but the lookups above were project-scoped, so the response must
    // say which project they were scoped to.
    if (effectiveProjectId) {
      response.projectId = effectiveProjectId
      if (projectContext) {
        response.projectContext = projectContext
      }
      if (bundesland) {
        response.bundesland = bundesland
      }
    }

    if (projectMemory) {
      response.projectMemory = projectMemory
    }

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    console.error('[WebSocket Scope API] Error:', error)

    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
