/**
 * Internal WebSocket Collection Scope Endpoint
 *
 * Called by server.js during the WebSocket upgrade handshake. It resolves the
 * current Grid session from the encrypted WorkOS cookie, builds the ordered
 * collection scope, and returns the base64url-encoded header value.
 *
 * Two serial legs, then everything else at once. The session and the
 * collection scope decide whether the caller may be here at all, so they come
 * first and alone; the eight lookups after them (flags, settings, model
 * overrides, budget, project profile, Bundesland, memory) are independent of
 * each other and used to run one after the other — ten awaited round-trips on
 * every socket rotation. They now run in one `Promise.all`. Each keeps the
 * failure posture it had: the ones that were best-effort still degrade to
 * "absent" with a warning, the two that were not (the reflection flag and the
 * project prompt view) still fail the upgrade.
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { getGridSession } from '@/lib/auth/session'
import {
  buildCollectionScopeFromRequest,
  type RequestContext,
  type RequestScope,
} from '@/lib/collection-scope-request'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProposalDecisionsBlock, composeMemoryContext } from '@/lib/projects/proposal-decisions'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { isMemoryReflectionEnabled } from '@/lib/workos/feature-flags'
import { isWebSearchEnabledForOrg } from '@/lib/organizations/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { getBudgetStatus } from '@/lib/budgets/service'
import { isAuthzError } from '@/lib/auth-utils'
import { isAuthRequired } from '@/lib/backend-proxy'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import type { GridSession } from '@/lib/auth/types'

/**
 * The `?scope=` query param, parsed at the one boundary it crosses.
 *
 * Absent means `project`, which is what every pre-Büro client sends and what
 * every pre-Büro branch below then takes. Anything else is a 400 rather than a
 * silent fall back to `project`: a client that misspells the office scope must
 * be told, not quietly given a project turn (spec KH-5).
 */
function parseRequestScope(raw: string | null): RequestScope | null {
  if (raw === null || raw === '' || raw === 'project') return 'project'
  if (raw === 'workspace') return 'workspace'
  return null
}

/**
 * The Büro is behind `workspace-chat`, fail-open while WorkOS flag enforcement
 * is off exactly like `organization-archiv` (spec WS-15). A session-less caller
 * — anonymous single-tenant mode — has no flags to read, so it passes only on
 * that same fail-open path and is refused once enforcement is on.
 */
function isWorkspaceChatEnabled(session: Pick<GridSession, 'featureFlags'> | null): boolean {
  return isFeatureEnabled(session ?? { featureFlags: null }, FEATURE_FLAGS.workspaceChat)
}

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
    const requestScope = parseRequestScope(searchParams.get('scope'))
    if (requestScope === null) {
      return NextResponse.json(
        { error: 'Bad Request', reason: "scope must be 'project' or 'workspace'" },
        { status: 400 }
      )
    }
    const conversationId = searchParams.get('conversationId') || undefined
    // A Büro upgrade carries no project, and a `projectId` alongside
    // `scope=workspace` is a contradiction rather than a hint: it is dropped
    // here, so nothing downstream — the scope builder, the profile loaders, the
    // budget scope — can be handed a project the office turn never had (KH-5).
    const projectId =
      requestScope === 'workspace' ? undefined : searchParams.get('projectId') || undefined

    const session = await getGridSession()

    if (isAuthRequired() && !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (requestScope === 'workspace' && !isWorkspaceChatEnabled(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Project mode passes exactly the context it always passed; the office turn
    // states its scope, which is what suppresses the active-project fallback in
    // the builder.
    const scopeContext: RequestContext =
      requestScope === 'workspace'
        ? { scope: 'workspace', conversationId }
        : { projectId, conversationId }

    const { scope, scopedCollections, headerValue } = await buildCollectionScopeFromRequest(
      session,
      scopeContext
    )

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
      // The (user, organization) pair WorkOS FGA keys on. `server.js` forwards
      // it as `x-grid-organization-membership-id` and signs it into the
      // request-context envelope, which is how the Büro's workspace digest can
      // filter the Projektregister to the projects THIS caller may read without
      // a WorkOS round trip of its own (ADR-0054, spec AC-4).
      response.organizationMembershipId = session.organizationMembershipId
      response.accessToken = session.accessToken
    }

    const organizationId = session?.organizationId

    const [
      memoryReflectionEnabled,
      webSearchEnabled,
      modelOverrides,
      budgetStatus,
      projectContext,
      bundesland,
      projectMemory,
    ] = await Promise.all([
      // Gate the async memory-reflection stage: with WorkOS flag enforcement
      // on, the per-org "memory-reflection" flag is the source of truth; without
      // enforcement it follows GRID_MEMORY_REFLECTION_ENABLED (default on) — see
      // isMemoryReflectionEnabled. server.js forwards this as
      // x-grid-feature-memory-reflection.
      isMemoryReflectionEnabled(organizationId),
      // Org-level web-search setting (ADR-0022): when off, server.js forwards
      // x-grid-disabled-sources and the backend subtracts the source from
      // every tool selection — enforcement, not just UI hiding. Best-effort:
      // a lookup failure must not take chat down (web search stays on).
      organizationId
        ? bestEffort('resolve web-search setting', () => isWebSearchEnabledForOrg(organizationId))
        : Promise.resolve(null),
      // Effective runtime model selection — the platform defaults
      // (`platform_model_defaults`) with the org's own active
      // org_model_configs version layered on top — forwarded by server.js as
      // x-grid-model-overrides. Best-effort: a config read failure must not
      // block chat; the workflow YAML models apply instead.
      organizationId
        ? bestEffort('load model overrides', () => getEffectiveModelOverrides(organizationId))
        : Promise.resolve(null),
      // Budget enforcement (ADR-0015): refuse the upgrade outright when a
      // budget scope is already exhausted, otherwise forward the remaining
      // budget so the backend tracker can stop a runaway turn mid-flight.
      // Fails OPEN on read errors — a broken budget lookup must not take
      // chat down; enforcement resumes on the next healthy upgrade.
      organizationId && session
        ? bestEffort('compute budget status', () =>
            getBudgetStatus(organizationId, session.userId, projectId ?? null)
          )
        : Promise.resolve(null),
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
      projectId ? loadProjectPromptView(projectId, organizationId) : Promise.resolve(null),
      // Structured jurisdiction fact (backlog T3-9 follow-up, 2026-07-16,
      // user-mandated) — becomes the envelope's `bundesland` field on the WS
      // upgrade (server.js), a parallel channel alongside the unchanged
      // `bundesland=<token>` line already inside `projectContext` above.
      // Best-effort: a lookup failure must not block the chat handshake, it
      // just means the backend falls back to prompt-text parsing.
      projectId
        ? bestEffort('load bundesland fact', () => loadProjectBundesland(projectId, organizationId))
        : Promise.resolve(null),
      // Core memory digest (bounded) — becomes x-grid-project-memory on the WS
      // upgrade. Merges project items with org-wide items; org knowledge applies
      // even outside a project-scoped chat. What the project decided about
      // earlier proposals rides the same channel. Best-effort: memory must
      // never block the chat handshake, and a failed digest drops the whole
      // block, as it always did.
      bestEffort('build project memory digest', async () => {
        const [digest, decisions] = await Promise.all([
          buildProjectMemoryDigest(projectId, organizationId ?? undefined),
          projectId && organizationId
            ? buildProposalDecisionsBlock(projectId, organizationId).catch(() => null)
            : Promise.resolve(null),
        ])
        return composeMemoryContext(digest, decisions)
      }),
    ])

    response.memoryReflectionEnabled = memoryReflectionEnabled

    if (organizationId) {
      if (webSearchEnabled === false) {
        response.disabledSources = ['web_search']
      }
      if (modelOverrides) {
        response.modelOverrides = modelOverrides
      }
      if (budgetStatus) {
        if (budgetStatus.blocked) {
          return NextResponse.json(
            {
              error: 'Budget exhausted',
              reason: `The ${budgetStatus.blockedScope} LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.`,
            },
            { status: 403 }
          )
        }
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

    if (projectId) {
      response.projectId = projectId
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
