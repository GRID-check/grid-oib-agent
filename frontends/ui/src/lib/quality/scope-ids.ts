/**
 * The bounds on a quality scope's organization and project ids, checked by
 * every endpoint that reads one (`lib/feedback/query.ts`, the scope bar's own
 * options route).
 *
 * Kept beside `./scope` rather than in it: the scope reader is shared with the
 * page, where an id list is whatever the URL holds, and these are the API's
 * refusals. A project id is compared with a uuid column, so a malformed one
 * would be a database error rather than an empty result, and each id is a bound
 * parameter, so the lists are capped.
 */

import type { QualityScope } from './scope'

/** Most organizations or projects one request may name. */
export const MAX_SCOPE_IDS = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What is wrong with a scope's ids, naming the parameter, or null. */
export function scopeIdsError(
  scope: Pick<QualityScope, 'organizationIds' | 'projectIds'>
): { error: 'too_many_values' | 'invalid_value'; param: 'org' | 'project' } | null {
  if (scope.organizationIds.length > MAX_SCOPE_IDS) return { error: 'too_many_values', param: 'org' }
  if (scope.projectIds.length > MAX_SCOPE_IDS) return { error: 'too_many_values', param: 'project' }
  if (scope.projectIds.some((id) => !UUID.test(id))) return { error: 'invalid_value', param: 'project' }
  return null
}
