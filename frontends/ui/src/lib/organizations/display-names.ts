/**
 * Organization id -> display name for a SET of ids, built on the one resolver
 * (`getOrganizationDisplayName`: Grid display name first, WorkOS name second,
 * cached, fail-soft). Platform surfaces that label rows by organization call
 * this rather than listing WorkOS organizations: a list call returns one page,
 * so every organization past it silently rendered as a bare id.
 */

import 'server-only'
import { getOrganizationDisplayName } from './service'

/** Lookups in flight at once, so a cold cache cannot fan out unbounded. */
const BATCH_SIZE = 10

/**
 * Resolve the names of `ids`. Unknown, unresolvable and null ids are simply
 * absent from the map; this never throws, because a label lookup must not fail
 * the surface it labels.
 */
export async function getOrganizationDisplayNames(
  ids: Iterable<string | null | undefined>
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))]
  const names = new Map<string, string>()
  for (let index = 0; index < unique.length; index += BATCH_SIZE) {
    const batch = unique.slice(index, index + BATCH_SIZE)
    const resolved = await Promise.all(
      batch.map((id) => getOrganizationDisplayName(id).catch(() => null))
    )
    batch.forEach((id, position) => {
      const name = resolved[position]
      if (name) names.set(id, name)
    })
  }
  return names
}
