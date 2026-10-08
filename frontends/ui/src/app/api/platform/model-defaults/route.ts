/**
 * Platform model defaults — the fleet-wide default model per agent group.
 * Platform owners only (ADR-0016), no per-org feature flag: this is the layer
 * *under* every tenant's configuration, not a tenant capability.
 *
 * GET — the agent-group registry, the current platform default per group, and
 *       the workflow YAML model each group falls back to when no default is set,
 *       each with `zdrSafe` checked against the LIVE ZDR list (null when the list
 *       cannot be read) — a default saved while ZDR-capable can lose its last
 *       ZDR endpoint later, and every ZDR organization inheriting it then has
 *       that group's requests refused.
 * PUT — validates every chosen model against the live OpenRouter catalog, the
 *       group's capability requirements AND a zero-data-retention endpoint that
 *       serves the group, then replaces the default set. Every organization is
 *       ZDR unless it opted out, so a default without one is refused (422,
 *       `not_zdr` / `zdr_endpoint_lacks_capability`), and a ZDR-list outage
 *       refuses the save (503, `details.reason: 'zdr_list_unavailable'`)
 *       rather than pinning the fleet to an unchecked model. Groups omitted
 *       from the body are cleared back to the YAML model.
 *
 * A save takes effect on the next turn for every organization that has not
 * overridden that group itself — no redeploy, no per-tenant action.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import {
  AGENT_GROUPS,
  AGENT_GROUP_IDS,
  OPENROUTER_MODEL_ID_PATTERN,
  getAgentGroup,
  isAgentGroupId,
} from '@/lib/model-config/agent-groups'
import { getWorkflowGroupDefaults, splitGroupDefault, type GroupDefaults } from '@/lib/model-config/backend-defaults'
import {
  catalogUnavailableError,
  fetchModelCatalog,
  fetchZdrEndpoints,
  hasZdrEndpoint,
  validateOverrides,
  type ZdrIndex,
} from '@/lib/model-config/openrouter'
import {
  listPlatformModelDefaults,
  savePlatformModelDefaults,
} from '@/lib/model-config/platform-defaults'

const putSchema = z.object({
  /**
   * The complete default set. Platform defaults are always OpenRouter
   * `author/slug` ids — unlike a tenant's BYOK override, this row is served to
   * every organization, so it must be a model the platform catalog knows.
   */
  defaults: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    z.object({ model: z.string().regex(OPENROUTER_MODEL_ID_PATTERN, 'not an OpenRouter model id') })
  ),
  note: z.string().trim().max(500).nullable().optional(),
})

// `platformApiRoute` supplies the owner gate, the request-bounded slot, the
// platform scope and the 403 mapping, so no handler re-implements them
// (ADR-0016, ADR-0041).
export const GET = platformApiRoute(
  async () => {
    // Platform-wide configuration, deliberately not one tenant's — and a
    // platform owner may have no active organization at all (the break-glass
    // first-run case), which is why the factory's platform scope is what this
    // reads under.
    const [rows, workflowDefaults, zdr] = await Promise.all([
      listPlatformModelDefaults(),
      // Best-effort: an unreachable backend just means the UI cannot name the
      // YAML fallback, which must not block managing the defaults themselves.
      getWorkflowGroupDefaults(),
      zdrIndexOrNull(),
    ])

    // A retired group's row stays in the table; the page sends back what it
    // loads, so returning it would make every save a 400. Dropped here, the
    // next save omits it and `savePlatformModelDefaults` deletes the row.
    const defaults = Object.fromEntries(
      rows.filter((row) => isAgentGroupId(row.agentGroup)).map((row) => [
        row.agentGroup,
        {
          model: row.model,
          note: row.note,
          updatedBy: row.updatedBy,
          updatedByEmail: row.updatedByEmail,
          updatedAt: row.updatedAt,
          // Live, not the save-time snapshot: a model can lose its last ZDR
          // endpoint after it was pinned.
          zdrSafe: liveZdrSafe(row.model, row.agentGroup, zdr),
        },
      ])
    )

    return NextResponse.json({
      agentGroups: AGENT_GROUPS,
      defaults,
      workflowDefaults,
      workflowDefaultsZdrSafe: workflowZdrSafe(workflowDefaults, zdr),
    })
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)

export const PUT = platformApiRoute(
  async ({ request, session }) => {
    // `parseJsonBody` raises a 400 with the issue list attached, so the shared
    // error mapping covers it.
    const input = await parseJsonBody(request, putSchema)
    const flat = Object.fromEntries(
      Object.entries(input.defaults).map(([group, value]) => [group, value.model])
    )

    // Server-side revalidation against the live platform catalog AND the ZDR
    // list — the picker is never trusted, and an outage of either rejects the
    // save rather than pinning the whole fleet to an unchecked model id.
    const [catalog, zdr] = await Promise.all([fetchModelCatalog(), fetchZdrEndpoints()]).catch((error: unknown) => {
      console.error('[Platform Model Defaults] Model catalog or ZDR list unavailable:', error)
      throw catalogUnavailableError(error)
    })
    const validation = validateOverrides(catalog, flat, true, zdr)
    if (!validation.ok) {
      throw new UnprocessableError('Model validation failed', validation.errors)
    }
    // `platform_model_defaults` grants the runtime role SELECT only (ADR-0041):
    // a tenant-facing bug must not be able to rewrite fleet-wide configuration.
    // Writing it is what the platform tier is for, and the factory has already
    // put this handler in that scope.
    const rows = await savePlatformModelDefaults({
      defaults: flat,
      modelSnapshot: validation.snapshot,
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
      // — but an unaudited change of this reach must not pass silently. The
      // actor stays out of the log: it is already persisted on the saved rows
      // (`updated_by` / `updated_by_email`), so no user identity is needed here.
      console.error(
        '[Platform Model Defaults] Fleet defaults were saved without an audit event: the platform organization did not resolve'
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
          },
        ])
      ),
    })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)

/** The ZDR list, or null when it cannot be read — GET reports that as "unknown", never as safe. */
async function zdrIndexOrNull(): Promise<ZdrIndex | null> {
  try {
    return await fetchZdrEndpoints()
  } catch (error) {
    console.warn('[Platform Model Defaults] ZDR list unavailable; ZDR status unknown:', error)
    return null
  }
}

/** Whether `modelId` has a ZDR endpoint serving the group; null when unknown. */
function liveZdrSafe(modelId: string, groupId: string, zdr: ZdrIndex | null): boolean | null {
  const group = getAgentGroup(groupId)
  if (!zdr || !group) return null
  return hasZdrEndpoint(modelId, zdr, group)
}

/** The same for each group's workflow YAML model(s); a multi-LLM group is safe only if all are. */
function workflowZdrSafe(workflowDefaults: GroupDefaults, zdr: ZdrIndex | null): Record<string, boolean | null> {
  return Object.fromEntries(
    Object.entries(workflowDefaults).map(([groupId, value]) => {
      const ids = splitGroupDefault(value)
      if (ids.length === 0) return [groupId, null]
      const verdicts = ids.map((id) => liveZdrSafe(id, groupId, zdr))
      return [groupId, verdicts.includes(null) ? null : verdicts.every(Boolean)]
    })
  )
}
