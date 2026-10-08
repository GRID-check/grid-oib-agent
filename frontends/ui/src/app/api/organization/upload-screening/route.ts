/**
 * The organization's upload-screening policy (ADR-0085).
 *
 * GET — any member: the upload dialog checks names against it before a byte is
 *       sent, so every uploader needs to read it. `suggested` is true while the
 *       office is still on Piloti's proposed list, and `suggestion` is that list,
 *       so the settings card can offer "back to the suggestion".
 * PUT — `org:settings:manage`. The only writer of `settings.uploadScreening`;
 *       the generic settings save refuses the key. Audited with counts.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { SUGGESTED_SCREENING_POLICY, uploadScreeningPolicySchema } from '@/lib/upload-screening/policy'
import {
  getUploadScreeningPolicy,
  hasSavedUploadScreeningPolicy,
  saveUploadScreeningPolicy,
} from '@/lib/upload-screening/service'

export const GET = apiRoute(
  async ({ session }) => {
    const [policy, saved] = await Promise.all([
      getUploadScreeningPolicy(session.organizationId),
      hasSavedUploadScreeningPolicy(session.organizationId),
    ])
    return { policy, suggested: !saved, suggestion: SUGGESTED_SCREENING_POLICY }
  },
  {
    authz: {
      sessionOnly: true,
      why: "every uploader screens names against their own organization's policy before sending a file; keyed by session.organizationId, and the write requires org:settings:manage below",
    },
  }
)

export const PUT = apiRoute(
  async ({ session, request }) => {
    const policy = await parseJsonBody(request, uploadScreeningPolicySchema)
    return { policy: await saveUploadScreeningPolicy(session, policy, request), suggested: false }
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
