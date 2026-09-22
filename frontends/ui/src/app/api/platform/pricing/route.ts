/**
 * The platform price list (ADR-0053, Platform → Overview → Pricing). Platform
 * owners only (ADR-0016), no per-org layer: the margin and the credit price are
 * the platform's, and every tenant is priced with them.
 *
 * GET — the effective pricing (the active version, or the boot floor with
 *       `explicit: false`), who set it, and the last few versions.
 * PUT — records a new version: validated against the service bounds (422 with
 *       per-field errors), supersedes the active one, invalidates the caches
 *       every ledger write and WebSocket upgrade read from. Applies to the NEXT
 *       generation recorded; nothing already on the ledger is repriced.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { parseJsonBody } from '@/lib/api/handler'
import { recordAuditEvent } from '@/lib/audit/service'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import { invalidateSeededLimits } from '@/lib/budgets/service'
import { getPricingView, PRICING_BOUNDS, REFERENCE_REQUEST, savePricing } from '@/lib/pricing/service'

const creditsSchema = z.number().min(0).finite().nullable()

const putSchema = z.object({
  marginMultiplier: z.number().finite(),
  usdPerCredit: z.number().finite(),
  defaultOrgDailyCredits: creditsSchema,
  defaultOrgMonthlyCredits: creditsSchema,
  note: z.string().trim().max(500).nullable().optional(),
})

export const GET = platformApiRoute(
  async () => {
    const pricing = await getPricingView()
    return NextResponse.json({ pricing, bounds: PRICING_BOUNDS, referenceRequest: REFERENCE_REQUEST })
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)

export const PUT = platformApiRoute(
  async ({ request, session }) => {
    const input = await parseJsonBody(request, putSchema)

    const version = await savePricing({
      marginMultiplier: input.marginMultiplier,
      usdPerCredit: input.usdPerCredit,
      defaultOrgDailyCredits: input.defaultOrgDailyCredits,
      defaultOrgMonthlyCredits: input.defaultOrgMonthlyCredits,
      note: input.note ?? null,
      actorUserId: session.userId,
      actorEmail: session.email ?? null,
    })
    // The seeded allowance is part of the price list; cached org limits that
    // came from it must not outlive the save.
    await invalidateSeededLimits()

    // Audit into the platform org's trail — a price-list change reprices every
    // tenant's next generation at once. Flat primitives only (WorkOS metadata).
    const platformOrgId = await getPlatformOrganizationId()
    if (platformOrgId) {
      await recordAuditEvent({
        organizationId: platformOrgId,
        actor: { userId: session.userId, email: session.email },
        action: 'platform.pricing.updated',
        targetType: 'platform_pricing_version',
        targetId: version.id,
        metadata: {
          marginMultiplier: input.marginMultiplier,
          usdPerCredit: input.usdPerCredit,
          defaultOrgDailyCredits: input.defaultOrgDailyCredits,
          defaultOrgMonthlyCredits: input.defaultOrgMonthlyCredits,
          supersedesId: version.supersedesId,
          note: input.note ?? null,
        },
        request,
      })
    } else {
      // The save stands — refusing a price-list change because the audit sink
      // is unreachable is worse — but a change of this reach must not pass
      // silently. The actor is already persisted on the version row.
      console.error(
        '[Platform Pricing] Pricing was saved without an audit event: the platform organization did not resolve'
      )
    }

    return NextResponse.json({ pricing: await getPricingView() })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
