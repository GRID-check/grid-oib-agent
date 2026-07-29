/**
 * Platform model defaults — the fleet-wide default model per agent group.
 * Platform owners only (ADR-0016), no per-org feature flag: this is the layer
 * *under* every tenant's configuration, not a tenant capability.
 *
 * GET — the agent-group registry, the current platform default per group, and
 *       the workflow YAML model each group falls back to when no default is set.
 * PUT — validates every chosen model against the live OpenRouter catalog and
 *       the group's capability requirements, then replaces the default set.
 *       Groups omitted from the body are cleared back to the YAML model.
 *
 * A save takes effect on the next turn for every organization that has not
 * overridden that group itself — no redeploy, no per-tenant action.
 */

import { NextResponse } from 'next/server'
import { ZodError, z } from 'zod'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, getPlatformOrganizationId, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError, ServiceUnavailableError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { AGENT_GROUPS, AGENT_GROUP_IDS, OPENROUTER_MODEL_ID_PATTERN } from '@/lib/model-config/agent-groups'
import { getWorkflowGroupDefaults } from '@/lib/model-config/backend-defaults'
import { baseModelId, fetchModelCatalog, fetchZdrModelIds, validateOverrides } from '@/lib/model-config/openrouter'
import { listPlatformModelDefaults, savePlatformModelDefaults } from '@/lib/model-config/platform-defaults'

const putSchema = z.object({
  /**
   * The complete default set. Platform defaults are always OpenRouter
   * `author/slug` ids — unlike a tenant's BYOK override, this row is served to
   * every organization, so it must be a model the platform catalog knows.
   */
  defaults: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    z.object({ model: z.string().regex(OPENROUTER_MODEL_ID_PATTERN, 'not an OpenRouter model id') }),
  ),
  note: z.string().trim().max(500).nullable().optional(),
})

export async function GET(): Promise<Response> {
  try {
    await requirePlatformOwner(await getGridSession())

    const [rows, workflowDefaults] = await Promise.all([
      listPlatformModelDefaults(),
      // Best-effort: an unreachable backend just means the UI cannot name the
      // YAML fallback, which must not block managing the defaults themselves.
      getWorkflowGroupDefaults(),
    ])

    const defaults = Object.fromEntries(
      rows.map((row) => [
        row.agentGroup,
        {
          model: row.model,
          note: row.note,
          updatedBy: row.updatedBy,
          updatedByEmail: row.updatedByEmail,
          updatedAt: row.updatedAt,
          // Surfaced so the owner can see when a default is not selectable for
          // Zero-Data-Retention tenants (see the PUT handler below).
          zdrSafe: zdrSafeFromSnapshot(row.modelSnapshot),
        },
      ]),
    )

    return NextResponse.json({ agentGroups: AGENT_GROUPS, defaults, workflowDefaults })
  } catch (error) {
    return handleError(error)
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    // requirePlatformOwner throws for a null session; this narrows the type.
    if (!session) throw new PlatformAccessDeniedError()

    const json = await request.json().catch(() => null)
    const input = putSchema.parse(json)
    const flat = Object.fromEntries(Object.entries(input.defaults).map(([group, value]) => [group, value.model]))

    // Server-side revalidation against the live platform catalog — the picker
    // is never trusted, and a catalog outage rejects the save rather than
    // pinning the whole fleet to an unvalidated model id.
    let catalog
    try {
      catalog = await fetchModelCatalog()
    } catch (error) {
      console.error('[Platform Model Defaults] Model catalog unavailable:', error)
      throw new ServiceUnavailableError('The model catalog is unavailable; try again later')
    }
    const validation = validateOverrides(catalog, flat, true)
    if (!validation.ok) {
      throw new UnprocessableError('Model validation failed', validation.errors)
    }

    // Zero-Data-Retention orgs inherit this default like anyone else, and a
    // model without a ZDR endpoint cannot serve them. Recorded per group rather
    // than rejected: the platform owner may legitimately pick a non-ZDR default
    // and let those few tenants pin their own model. Best-effort — the ZDR
    // listing being down must not block a routine model bump.
    let zdrModelIds: Set<string> | null = null
    try {
      zdrModelIds = await fetchZdrModelIds()
    } catch (error) {
      console.warn('[Platform Model Defaults] Could not resolve the ZDR model listing:', error)
    }
    const modelSnapshot = Object.fromEntries(
      Object.entries(validation.snapshot).map(([group, model]) => [
        group,
        { ...model, _zdr: { safe: zdrModelIds ? zdrModelIds.has(baseModelId(model.id)) : null } },
      ]),
    )

    const rows = await savePlatformModelDefaults({
      defaults: flat,
      modelSnapshot,
      note: input.note ?? null,
      actorUserId: session.userId,
      actorEmail: session.email ?? null,
    })

    // Audit into the platform org's trail — a fleet-wide model swap is the
    // single most far-reaching change this surface can make.
    const platformOrgId = await getPlatformOrganizationId()
    if (platformOrgId) {
      await recordAuditEvent({
        organizationId: platformOrgId,
        actor: { userId: session.userId, email: session.email },
        action: 'platform.model_defaults.updated',
        targetType: 'platform_model_defaults',
        targetId: 'platform',
        metadata: flat,
        request,
      })
    } else {
      // The platform org did not resolve (not provisioned, or a WorkOS miss
      // cached by its own fail-closed TTL). The save stands — refusing a
      // fleet-wide model bump because the audit sink is unreachable is worse
      // — but an unaudited change of this reach must not pass silently.
      console.error(
        `[Platform Model Defaults] Fleet defaults saved by ${session.email ?? session.userId} were NOT audited: the platform organization did not resolve`,
      )
    }

    return NextResponse.json({
      defaults: Object.fromEntries(
        rows.map((row) => [
          row.agentGroup,
          {
            model: row.model,
            note: row.note,
            updatedBy: row.updatedBy,
            updatedByEmail: row.updatedByEmail,
            updatedAt: row.updatedAt,
            zdrSafe: zdrSafeFromSnapshot(row.modelSnapshot),
          },
        ]),
      ),
    })
  } catch (error) {
    return handleError(error)
  }
}

/** `true`/`false` when the ZDR listing was reachable at save time, else null. */
function zdrSafeFromSnapshot(snapshot: unknown): boolean | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const zdr = (snapshot as { _zdr?: unknown })._zdr
  if (!zdr || typeof zdr !== 'object') return null
  const safe = (zdr as { safe?: unknown }).safe
  return typeof safe === 'boolean' ? safe : null
}

function handleError(error: unknown): Response {
  if (error instanceof PlatformAccessDeniedError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'Invalid model defaults', code: 'BAD_REQUEST', details: error.flatten() },
      { status: 400 },
    )
  }
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    )
  }
  const denied = authzErrorResponse(error)
  if (denied) return denied
  throw error
}
