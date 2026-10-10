/**
 * Platform → Answer quality: the options of the page-wide scope bar.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   the range (or `days=7|30|90`)
 *   ?org=…                            repeatable: the chosen organizations
 *   ?project=…                        repeatable: the chosen projects
 *
 * Answers `{ organizations, organizationsTruncated, projects, projectsTruncated }`:
 * the organizations with any vote, citation check or profiled turn in the range
 * (named), and the projects of the chosen organizations. Not ratings-specific,
 * because the bar scopes every quality view. A malformed range is a 400.
 *
 * Gated in the factory on `platform:organizations:view`, like every other read
 * on the page; the reads are `lib/quality/scope-options.ts`.
 */

import { BadRequestError } from '@/lib/api/errors'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { parseQualityScopeStrict } from '@/lib/quality/scope'
import { scopeIdsError } from '@/lib/quality/scope-ids'
import { getQualityScopeOptions } from '@/lib/quality/scope-options'

export const GET = platformApiRoute(
  async ({ request }) => {
    const parsed = parseQualityScopeStrict(new URL(request.url).searchParams)
    if (!parsed.ok) throw new BadRequestError(`Invalid scope (${parsed.error}).`, { error: parsed.error })
    const idsError = scopeIdsError(parsed.scope)
    if (idsError) throw new BadRequestError(`Invalid parameter "${idsError.param}" (${idsError.error}).`, idsError)
    return getQualityScopeOptions(parsed.scope)
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
