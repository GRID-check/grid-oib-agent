/**
 * Platform retrieval settings — the fleet-wide retrieval counts (Platform →
 * Retrieval). Platform owners only (ADR-0016), no per-org feature flag: this
 * is the layer *under* every tenant's traffic, not a tenant capability.
 *
 * GET — the setting catalog (labels, bounds, defaults) and the effective
 *       value per key (pinned row or boot default).
 * PUT — validates every value against the catalog bounds, then replaces the
 *       whole set. Keys omitted from the body return to their boot default.
 *
 * A save reaches the backend on its next resolution (the backend TTL-caches
 * `GET /api/internal/retrieval-settings` for at most a minute) — no redeploy.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { parseJsonBody } from '@/lib/api/handler'
import { recordAuditEvent } from '@/lib/audit/service'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { RETRIEVAL_SETTINGS } from '@/lib/retrieval-settings/catalog'
import {
  listPlatformRetrievalSettings,
  savePlatformRetrievalSettings,
} from '@/lib/retrieval-settings/service'

const putSchema = z.object({
  /** The complete settings set: `{key: count}`. Omitted keys are cleared. */
  settings: z.record(z.string(), z.number().int()),
  note: z.string().trim().max(500).nullable().optional(),
})

export const GET = platformApiRoute(async () => {
  const settings = await listPlatformRetrievalSettings()
  return NextResponse.json({ definitions: RETRIEVAL_SETTINGS, settings })
})

export const PUT = platformApiRoute(async ({ request, session }) => {
  const input = await parseJsonBody(request, putSchema)

  await savePlatformRetrievalSettings({
    settings: input.settings,
    note: input.note ?? null,
    actorUserId: session.userId,
    actorEmail: session.email ?? null,
  })

  // Audit into the platform org's trail — a fleet-wide retrieval-depth change
  // shifts recall and token spend for every tenant at once. The settings map
  // is serialized: WorkOS metadata is flat primitives only.
  const platformOrgId = await getPlatformOrganizationId()
  if (platformOrgId) {
    await recordAuditEvent({
      organizationId: platformOrgId,
      actor: { userId: session.userId, email: session.email },
      action: 'platform.retrieval_settings.updated',
      targetType: 'platform_retrieval_settings',
      targetId: 'platform',
      metadata: {
        settings: JSON.stringify(input.settings),
        changed: Object.keys(input.settings).length,
        note: input.note ?? null,
      },
      request,
    })
  } else {
    // The save stands — refusing a fleet-wide change because the audit sink
    // is unreachable is worse — but an unaudited change of this reach must
    // not pass silently. The actor stays out of the log: it is already
    // persisted on the saved rows (`updated_by` / `updated_by_email`).
    console.error(
      '[Platform Retrieval Settings] Settings were saved without an audit event: the platform organization did not resolve'
    )
  }

  return NextResponse.json({ settings: await listPlatformRetrievalSettings() })
})
