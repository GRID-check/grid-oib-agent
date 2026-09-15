/**
 * The organization's standing instruction block.
 *
 * GET — any member may read it. The block shapes every answer they get, so it
 *       is not a secret from them; the read is keyed by `session.organizationId`
 *       and reaches nothing else.
 * PUT — `org:settings:manage`, the permission ADR-0016's registry defines for
 *       settings that shape how the organization behaves for everyone in it
 *       (the same gate as `/api/organization/settings`). An empty body clears
 *       the block.
 *
 * Thin handlers; all logic lives in `@/lib/org-instructions/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import {
  getOrgInstructions,
  orgInstructionsSchema,
  saveOrgInstructions,
} from '@/lib/org-instructions/service'

export const GET = apiRoute(
  async ({ session }) => ({ instructions: await getOrgInstructions(session.organizationId) }),
  {
    authz: {
      sessionOnly: true,
      why: "every member may read the instruction block that shapes their own organization's answers; the read is keyed by session.organizationId and writing requires org:settings:manage below",
    },
  },
)

export const PUT = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, orgInstructionsSchema)
    return { instructions: await saveOrgInstructions(session, input, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } },
)
