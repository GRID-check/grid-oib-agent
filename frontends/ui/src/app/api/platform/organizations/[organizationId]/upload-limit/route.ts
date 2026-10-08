/**
 * Platform-owner control of one organization's per-file upload limit.
 *
 * A sibling of `../storage` rather than a second field on its PUT. That body is
 * `{ quotaBytes }` with `null` meaning UNLIMITED; here `null` means "back to the
 * deployment default". Folding both into one body would give `null` two
 * meanings in one request and turn a required field into an optional one, so
 * each setting keeps one contract, one audit action and one refusal.
 *
 * The read lives in `GET /api/platform/storage` (every row carries its own and
 * its effective limit), so this route has no GET of its own.
 *
 * `platformApiRoute` checks `platform:organizations:manage` before the handler;
 * `setMaxUploadFileBytes` checks again, because it writes a platform-owned
 * setting and an audit row whichever route calls it.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { uploadLimitPutSchema } from '@/lib/storage/contract'
import { setMaxUploadFileBytes } from '@/lib/storage/upload-limit'

interface Params {
  organizationId: string
}

/** Set (bytes) or clear (`null`) the limit. Below 1 MB is a 400; above the transport ceiling a 422. */
export const PUT = platformApiRoute<Params>(
  async ({ session, request, params }) => {
    const { maxUploadFileBytes } = await parseJsonBody(request, uploadLimitPutSchema)
    return setMaxUploadFileBytes(session, params.organizationId, maxUploadFileBytes, request)
  },
  { permission: PLATFORM_PERMISSIONS.organizationsManage }
)
