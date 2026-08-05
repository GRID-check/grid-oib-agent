/**
 * Platform reasoning efforts — the fleet-wide "thinking level" per agent group.
 * Platform owners only (ADR-0016), no per-org feature flag and no org layer at
 * all: a tenant choosing its own model is a product feature, a tenant dialling
 * its own reasoning spend is not.
 *
 * GET — the agent-group registry, the current effort per group, and the
 *       workflow YAML `reasoning_effort` each group falls back to when unset.
 * PUT — validates every chosen effort against the catalog vocabulary, then
 *       replaces the set. Groups omitted from the body are cleared back to the
 *       YAML value.
 *
 * A save takes effect on the next turn for every organization — no redeploy.
 */

import { z } from 'zod'
import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { recordAuditEvent } from '@/lib/audit/service'
import { AGENT_GROUPS, AGENT_GROUP_IDS } from '@/lib/model-config/agent-groups'
import { getWorkflowGroupReasoningEfforts } from '@/lib/model-config/backend-defaults'
import { REASONING_EFFORTS } from '@/lib/reasoning-settings/catalog'
import {
  listPlatformReasoningEfforts,
  savePlatformReasoningEfforts,
} from '@/lib/reasoning-settings/service'

const putSchema = z.object({
  /** The complete effort set; groups omitted are cleared back to the YAML. */
  efforts: z.record(z.enum(AGENT_GROUP_IDS as [string, ...string[]]), z.enum(REASONING_EFFORTS)),
  note: z.string().trim().max(500).nullable().optional(),
})

export const GET = platformApiRoute(async () => {
  const [rows, workflowEfforts] = await Promise.all([
    listPlatformReasoningEfforts(),
    // Best-effort: an unreachable backend just means the UI cannot name the
    // YAML fallback, which must not block managing the efforts themselves.
    getWorkflowGroupReasoningEfforts(),
  ])

  const efforts = Object.fromEntries(
    rows.map((row) => [
      row.agentGroup,
      {
        effort: row.effort,
        note: row.note,
        updatedBy: row.updatedBy,
        updatedByEmail: row.updatedByEmail,
        updatedAt: row.updatedAt,
      },
    ]),
  )

  return { agentGroups: AGENT_GROUPS, efforts, workflowEfforts }
})

export const PUT = platformApiRoute(async ({ request, session }) => {
  // `parseJsonBody`, not a bare `schema.parse`: it turns a schema violation into
  // a 400 with the field details. A raw ZodError falls through `errorResponse`
  // as an unhandled 500, which reports a malformed payload as our fault.
  const input = await parseJsonBody(request, putSchema)

  // No catalog round-trip, unlike the model defaults: the accepted values are a
  // closed vocabulary we own, and whether a given MODEL honours a level is
  // OpenRouter's business (it maps to the nearest supported one). So an upstream
  // outage can never block an effort change — which matters, because dialling
  // effort DOWN is the lever an operator reaches for when a run burns tokens.
  const rows = await savePlatformReasoningEfforts({
    efforts: input.efforts,
    note: input.note ?? null,
    actorUserId: session.userId,
    actorEmail: session.email ?? null,
  })

  const platformOrgId = await getPlatformOrganizationId()
  if (platformOrgId) {
    await recordAuditEvent({
      organizationId: platformOrgId,
      actor: { userId: session.userId, email: session.email },
      action: 'platform.reasoning_efforts.updated',
      targetType: 'platform_reasoning_efforts',
      targetId: 'platform',
      metadata: input.efforts,
      request,
    })
  } else {
    // Same reasoning as the model-defaults route: the save stands (refusing a
    // fleet-wide change because the audit sink is unreachable is worse), but an
    // unaudited change of this reach must not pass silently.
    console.error(
      '[Platform Reasoning] Fleet efforts were saved without an audit event: the platform organization did not resolve',
    )
  }

  return {
    efforts: Object.fromEntries(
      rows.map((row) => [
        row.agentGroup,
        {
          effort: row.effort,
          note: row.note,
          updatedBy: row.updatedBy,
          updatedByEmail: row.updatedByEmail,
          updatedAt: row.updatedAt,
        },
      ]),
    ),
  }
})
