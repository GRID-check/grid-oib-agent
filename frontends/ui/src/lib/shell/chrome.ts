import 'server-only'

import { getGridSession } from '@/lib/auth/session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getNavFlags, type NavFlags } from '@/lib/authz/nav'
import { isIfcModelsEnabled, isSkillsEnabled } from '@/lib/authz/feature-flags'
import { listProjects } from '@/lib/projects/service'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { isAuthRequired } from '@/lib/auth/auth-required'
import type { ProjectSwitcherProject } from '@/components/shell/project-switcher'
import type { SidebarUser } from '@/components/shell/sidebar-user-menu'

/**
 * Everything the persistent app frame needs to draw itself, for one reader.
 *
 * The rail used to be assembled inside `app/projects/[id]/layout.tsx`, which is
 * why it existed only inside a project: the moment the reader stepped up to the
 * Archiv, the Postfach, Organisation, Plattform or Profil, the whole chrome
 * unmounted. Nothing in this shape is per-project — `getNavFlags`,
 * `isSkillsEnabled` and `isIfcModelsEnabled` all take only the session, and the
 * project list is org-wide — so it can be resolved once, in the common
 * ancestor, and handed to a rail that is mounted exactly once per tab.
 */
export interface ShellChrome {
  /** Org-wide projects the reader may see, name-sorted; empty when unresolvable. */
  projects: ProjectSwitcherProject[]
  /** Identity for the rail footer. Undefined when there is no session. */
  user?: SidebarUser
  /** The org the reader is acting in, for the footer eyebrow. */
  organizationName: string | null
  navFlags: NavFlags
  /** Agent Skills + Jobs sections (`skills` flag, ADR-0046). */
  showSkills: boolean
  /** IFC/BIM model surfaces (`ifc-models`, ADR-0045). */
  showModels: boolean
  authRequired: boolean
}

const EMPTY_NAV_FLAGS: NavFlags = {
  canManageOrganization: false,
  canViewOrganization: false,
  canManagePlatform: false,
  canAccessArchiv: false,
  canCollaborate: false,
  canAccessInbox: false,
}

/** The frame with nothing in it: what a signed-out or broken lookup renders. */
function emptyChrome(): ShellChrome {
  return {
    projects: [],
    user: undefined,
    organizationName: null,
    navFlags: EMPTY_NAV_FLAGS,
    showSkills: false,
    showModels: false,
    authRequired: isAuthRequired(),
  }
}

/**
 * Resolve the frame's data for the current request. TOLERANT BY CONSTRUCTION:
 * it never redirects and never throws.
 *
 * That is a hard requirement, not defensiveness. The frame sits above
 * `/app/platform`, and ADR-0016 says the break-glass platform owner of a fresh
 * environment may hold ZERO org memberships — the org-onboarding redirect that
 * `withPageSession` performs would lock exactly that person out of the only
 * page that can fix it. Every page below the frame still runs its own guard, so
 * a reader who should be redirected is redirected by the page, one segment
 * later, with the frame having decided nothing.
 *
 * The same reasoning applies field by field: a failed project list yields an
 * empty switcher, a failed org lookup yields no eyebrow. Chrome must never be
 * the reason a page cannot render.
 */
export async function resolveShellChrome(): Promise<ShellChrome> {
  let session: Awaited<ReturnType<typeof getGridSession>> = null
  try {
    session = await getGridSession()
  } catch {
    return emptyChrome()
  }
  if (!session) return emptyChrome()

  const authRequired = isAuthRequired()

  let navFlags = EMPTY_NAV_FLAGS
  try {
    navFlags = await getNavFlags(session)
  } catch {
    // Fall through with all-false flags: a rail with fewer entries beats a
    // page that 500s because a capability lookup was slow or down.
  }

  // The switcher goes through the service, never a raw org-wide select: it is a
  // list of project names and ids, which is exactly what ADR-0038 says a member
  // without `project:view` must not be handed. Ordering by name is presentation,
  // applied to the reachable set.
  let projects: ProjectSwitcherProject[] = []
  if (session.organizationId) {
    try {
      projects = (await listProjects(session as AuthorizedSession))
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      projects = []
    }
  }

  let organizationName: string | null = null
  try {
    organizationName = await getOrganizationDisplayName(session.organizationId)
  } catch {
    organizationName = null
  }

  return {
    projects,
    user: { name: session.name, email: session.email },
    organizationName,
    navFlags,
    showSkills: isSkillsEnabled(session),
    showModels: isIfcModelsEnabled(session),
    authRequired,
  }
}
