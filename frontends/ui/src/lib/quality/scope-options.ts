/**
 * What the quality scope bar can offer: the organizations active in a range,
 * named, and the projects of the ones chosen.
 *
 * Not ratings-specific: an organization is offered when it has a vote, a
 * citation check or a profiled turn in the range, because the bar scopes all
 * three views. Selected organizations and projects are always in the answer,
 * active or not, so a chip from a link is named rather than shown as an id.
 *
 * The caller (`platformApiRoute`) has already required
 * `platform:organizations:view` and runs this under the platform bypass.
 */

import 'server-only'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { scopeBounds, type QualityScope } from './scope'
import { listActiveOrganizationIds, listScopeProjects } from './scope-options-repository'

export interface QualityScopeOrganizationOption {
  id: string
  /** Null when the name lookup missed; the picker shows the id. */
  name: string | null
}

export interface QualityScopeProjectOption {
  id: string
  name: string
  organizationId: string
}

export interface QualityScopeOptions {
  organizations: QualityScopeOrganizationOption[]
  /** True when more organizations were active than the list holds. */
  organizationsTruncated: boolean
  /** Projects of the chosen organizations (empty when none is chosen), plus the chosen projects. */
  projects: QualityScopeProjectOption[]
  projectsTruncated: boolean
}

export async function getQualityScopeOptions(scope: QualityScope): Promise<QualityScopeOptions> {
  const { start, endExclusive } = scopeBounds(scope)
  const [active, projects] = await Promise.all([
    listActiveOrganizationIds(start, endExclusive),
    listScopeProjects(scope.organizationIds, scope.projectIds),
  ])
  const ids = [...new Set([...scope.organizationIds, ...active.ids])]
  const names = await getOrganizationDisplayNames(ids)
  const organizations = ids
    .map((id) => ({ id, name: names.get(id) ?? null }))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, 'de'))
  return {
    organizations,
    organizationsTruncated: active.truncated,
    projects: projects.projects,
    projectsTruncated: projects.truncated,
  }
}
