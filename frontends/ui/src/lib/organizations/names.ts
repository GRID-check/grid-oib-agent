/**
 * Organization id -> display name, for the cross-tenant platform surfaces that
 * list organizations by id (citation health, answer feedback).
 *
 * One resolver for all of them, so two platform cards never name the same
 * tenant differently. Best-effort: a WorkOS outage degrades the surface to bare
 * ids (`null` names), it never fails the read the names decorate.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'

/** WorkOS's page ceiling; the platform has far fewer tenants than this. */
const ORGANIZATION_NAME_PAGE = 100

export async function listOrganizationNames(): Promise<Map<string, string>> {
  try {
    const list = await getWorkOS().organizations.listOrganizations({ limit: ORGANIZATION_NAME_PAGE })
    return new Map(list.data.map((org) => [org.id, org.name]))
  } catch {
    return new Map()
  }
}
