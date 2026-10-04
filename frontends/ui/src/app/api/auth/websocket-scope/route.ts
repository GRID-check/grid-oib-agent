/**
 * Internal WebSocket Collection Scope Endpoint
 *
 * Called by server.js during the WebSocket upgrade handshake. It resolves the
 * current Grid session from the encrypted WorkOS cookie, builds the ordered
 * collection scope, and returns the base64url-encoded header value.
 *
 * The authenticated handshake carries only identity, scope and policy. Prompt blocks are
 * loaded by the authenticated per-turn POST /api/internal/turn-context route,
 * never here: base64 expansion alone can exceed the upstream header-line limit.
 * Anonymous upgrades retain their legacy inline prompt blocks.
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
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
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

    // Echoed so `server.js` signs the conversation it was ALLOWED to sign.
    // `buildCollectionScopeFromRequest` has just run `authorizeConversationScope`
    // on this id (and the upgrade is refused when that throws), so what goes into
    // the envelope is an id this tier asserted rather than the query param the
    // client sent. The agent's document route authorizes on the verified payload
    // (ADR-0054 §4) — a caller-chosen value must never reach it under a
    // signature.
    if (conversationId) {
      response.conversationId = conversationId
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
    const bundesland = effectiveProjectId
      ? await bestEffort('load bundesland fact', () =>
          loadProjectBundesland(effectiveProjectId, organizationId)
        )
      : null

    if (!organizationId || !session?.userId) {
      const [projectContext, projectMemory, orgInstructions] = await Promise.all([
        effectiveProjectId ? loadProjectPromptView(effectiveProjectId, organizationId) : Promise.resolve(null),
        bestEffort('build project memory digest', () =>
          buildProjectMemoryDigest(effectiveProjectId, organizationId ?? undefined)
        ),
        organizationId ? resolveOrgInstructions(organizationId) : Promise.resolve(null),
      ])
      if (projectContext) response.projectContext = projectContext
      if (projectMemory) response.projectMemory = projectMemory
      if (orgInstructions) response.orgInstructions = orgInstructions
    }

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
      if (bundesland) {
        response.bundesland = bundesland
      }
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
