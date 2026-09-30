/**
 * Zero-Data-Retention policy toggle (ADR-0014 privacy control).
 *
 * PUT — `org:models:manage` holders, behind the model-configuration flag. The
 *       only writer of `settings.zdrOnly` (the generic settings save refuses
 *       it). ZDR is on unless an org explicitly turned it off; while on, the
 *       model picker and the save paths accept only models with a ZDR endpoint,
 *       and the Python backend adds `provider.zdr` (+ `data_collection: deny`)
 *       to every OpenRouter request for the org. Audited with the value before
 *       and after.
 *
 * Turning ZDR ON is never refused, even when a group's effective model has no
 * ZDR endpoint: refusing a privacy control would leave data flowing to
 * endpoints that retain it. The response names those groups instead
 * (`zdrCoverage`), because with ZDR on their requests are refused by the
 * provider until an admin picks a ZDR model.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { isZdrApplicableForOrg } from '@/lib/model-config/org-catalog'
import { getZdrCoverage, UNKNOWN_COVERAGE, type ZdrCoverage } from '@/lib/model-config/zdr-coverage'
import { setOrgZdrOnly } from '@/lib/organizations/service'

const putSchema = z.object({ enabled: z.boolean() })

export const PUT = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const { enabled } = await parseJsonBody(request, putSchema)
    const { zdrOnly } = await setOrgZdrOnly(session, enabled, request)
    // The switch has moved. Nothing after this line may turn the response into
    // an error: a 500 here would leave the card showing the old state while
    // traffic already follows the new one.
    return { zdrOnly, ...(await describeAfterSave(session.organizationId, zdrOnly)) }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)

/**
 * Applicability and coverage for the response, best-effort. A failure reads
 * as unknown (`zdrApplicable: null`, coverage `status: 'unknown'`), which the
 * card says out loud, never as "all clear".
 */
async function describeAfterSave(
  organizationId: string,
  zdrOnly: boolean
): Promise<{ zdrApplicable: boolean | null; zdrCoverage: ZdrCoverage | null }> {
  const [applicable, coverage] = await Promise.allSettled([
    isZdrApplicableForOrg(organizationId),
    zdrOnly ? getZdrCoverage(organizationId) : Promise.resolve(null),
  ])
  const zdrApplicable = applicable.status === 'fulfilled' ? applicable.value : null
  if (applicable.status === 'rejected') {
    console.warn('[Model Config API] ZDR saved; could not resolve whether it applies:', applicable.reason)
  }
  if (coverage.status === 'rejected') {
    console.warn('[Model Config API] ZDR saved; could not compute its coverage:', coverage.reason)
  }
  if (!zdrOnly || zdrApplicable === false) return { zdrApplicable, zdrCoverage: null }
  return {
    zdrApplicable,
    zdrCoverage: coverage.status === 'fulfilled' ? coverage.value : UNKNOWN_COVERAGE,
  }
}
