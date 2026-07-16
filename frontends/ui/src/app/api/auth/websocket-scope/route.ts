/**
 * Internal WebSocket Collection Scope Endpoint
 *
 * Called by server.js during the WebSocket upgrade handshake. It resolves the
 * current Grid session from the encrypted WorkOS cookie, builds the ordered
 * collection scope, and returns the base64url-encoded header value.
 */

import { NextResponse } from 'next/server'
import { getGridSession } from '@/lib/auth/session'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { isOrgFeatureEnabled, MEMORY_REFLECTION_FLAG } from '@/lib/workos/feature-flags'
import { isWebSearchEnabledForOrg } from '@/lib/organizations/service'
import { getActiveModelOverrides } from '@/lib/model-config/service'
import { getBudgetStatus } from '@/lib/budgets/service'
import { isAuthzError } from '@/lib/auth-utils'
import { isAuthRequired } from '@/lib/backend-proxy'

/**
 * Fallback for anonymous / non-WorkOS deployments: when no org is in scope the
 * feature flag can't be evaluated, so honour an env opt-in instead.
 */
const memoryReflectionEnvDefault = (): boolean =>
  process.env.MEMORY_REFLECTION_ENABLED?.toLowerCase() === 'true'

export async function GET(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId') || undefined
    const conversationId = searchParams.get('conversationId') || undefined

    const session = await getGridSession()

    if (isAuthRequired() && !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { scope, headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId,
      conversationId,
    })

    const response: Record<string, unknown> = {
      scope,
      header: headerValue,
    }

    if (session) {
      response.organizationId = session.organizationId
      response.userId = session.userId
      response.accessToken = session.accessToken
    }

    // Gate the async memory-reflection stage on a WorkOS feature flag
    // ("memory-reflection") evaluated for the caller's org; fall back to the
    // MEMORY_REFLECTION_ENABLED env opt-in when there is no org (anonymous
    // mode). Fail-closed. server.js forwards this as x-grid-feature-memory-reflection.
    response.memoryReflectionEnabled = session?.organizationId
      ? await isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, session.organizationId, memoryReflectionEnvDefault())
      : memoryReflectionEnvDefault()

    if (session?.organizationId) {
      // Org-level web-search setting (ADR-0022): when off, server.js forwards
      // x-grid-disabled-sources and the backend subtracts the source from
      // every tool selection — enforcement, not just UI hiding. Best-effort:
      // a lookup failure must not take chat down (web search stays on).
      try {
        if (!(await isWebSearchEnabledForOrg(session.organizationId))) {
          response.disabledSources = ['web_search']
        }
      } catch (error) {
        console.warn('[WebSocket Scope API] Failed to resolve web-search setting:', error)
      }

      // Per-org runtime model overrides (active org_model_configs version) —
      // forwarded by server.js as x-grid-model-overrides. Best-effort: a
      // config read failure must not block chat; defaults apply instead.
      try {
        const modelOverrides = await getActiveModelOverrides(session.organizationId)
        if (modelOverrides) {
          response.modelOverrides = modelOverrides
        }
      } catch (error) {
        console.warn('[WebSocket Scope API] Failed to load model overrides:', error)
      }

      // Budget enforcement (ADR-0015): refuse the upgrade outright when a
      // budget scope is already exhausted, otherwise forward the remaining
      // budget so the backend tracker can stop a runaway turn mid-flight.
      // Fails OPEN on read errors — a broken budget lookup must not take
      // chat down; enforcement resumes on the next healthy upgrade.
      try {
        const budgetStatus = await getBudgetStatus(session.organizationId, session.userId, projectId ?? null)
        if (budgetStatus.blocked) {
          return NextResponse.json(
            {
              error: 'Budget exhausted',
              reason: `The ${budgetStatus.blockedScope} LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.`,
            },
            { status: 403 },
          )
        }
        response.budget = {
          remainingOrgUsd: budgetStatus.remainingOrgUsd,
          remainingUserUsd: budgetStatus.remainingUserUsd,
          remainingProjectUsd: budgetStatus.remainingProjectUsd,
        }
      } catch (error) {
        console.warn('[WebSocket Scope API] Failed to compute budget status:', error)
      }
    }

    if (projectId) {
      // Access is already enforced: buildCollectionScopeFromRequest ran
      // requireProjectAccess for this exact (session, projectId) under the
      // same auth-required condition, so re-checking here only repeated the
      // tenancy query and FGA round-trips.
      // Residual exposure: when REQUIRE_AUTH is off (anonymous single-tenant
      // deployments) there is no session, so the caller-supplied projectId
      // reaches loadProjectPromptView and the memory digest unchecked. The
      // service layer pins queries to session.organizationId whenever a
      // session exists (defense-in-depth); fully gating anonymous mode is a
      // product decision.
      response.projectId = projectId
      const projectContext = await loadProjectPromptView(projectId)
      if (projectContext) {
        response.projectContext = projectContext
      }

      // Structured jurisdiction fact (backlog T3-9 follow-up, 2026-07-16,
      // user-mandated) — becomes the envelope's `bundesland` field on the WS
      // upgrade (server.js), a parallel channel alongside the unchanged
      // `bundesland=<token>` line already inside `projectContext` above.
      // Best-effort: a lookup failure must not block the chat handshake, it
      // just means the backend falls back to prompt-text parsing.
      try {
        const bundesland = await loadProjectBundesland(projectId)
        if (bundesland) {
          response.bundesland = bundesland
        }
      } catch (error) {
        console.warn('[WebSocket Scope API] Failed to load bundesland fact:', error)
      }
    }

    // Core memory digest (bounded) — becomes x-grid-project-memory on the WS
    // upgrade. Merges project items with org-wide items; org knowledge applies
    // even outside a project-scoped chat. Best-effort: memory must never block
    // the chat handshake.
    try {
      const projectMemory = await buildProjectMemoryDigest(projectId, session?.organizationId ?? undefined)
      if (projectMemory) {
        response.projectMemory = projectMemory
      }
    } catch (error) {
      console.warn('[WebSocket Scope API] Failed to build project memory digest:', error)
    }

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    console.error('[WebSocket Scope API] Error:', error)

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}

