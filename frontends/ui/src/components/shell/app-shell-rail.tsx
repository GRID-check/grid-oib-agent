'use client'

/**
 * The rail, mounted ONCE for the whole authenticated app.
 *
 * This component is the reason the chrome stops flickering. It lives in the
 * `(shell)` layout — the common ancestor of the projects, the Archiv, the
 * Postfach, Organisation, Plattform and Profil — and Next.js does not re-render
 * a layout on navigation, so React never unmounts it. Walking from a project
 * into the Postfach now swaps only the page: the 236px rail, the content
 * column's width and the scroll container all stay exactly where they were.
 *
 * Scope is read from the pathname rather than passed down, for the same reason:
 * a prop would have to come from a server segment, and the only segment that
 * knows a project id is the one BELOW this layout — which is precisely the
 * segment whose remount was the bug. `usePathname()` is what the Next 16 docs
 * point at for this ("Layouts do not re-render on navigation… read the current
 * pathname in a Client Component"), and reading it here costs one re-render of
 * a component that is already mounted instead of a teardown of the whole frame.
 *
 * A parallel route (`@rail`) was considered and rejected: a catch-all slot
 * re-renders on every navigation, which destroys exactly the persistence this
 * exists for.
 */

import { usePathname } from 'next/navigation'

import { AppSidebar } from './app-sidebar'
import { projectIdFromPathname } from './org-sections'
import type { ProjectSwitcherProject } from './project-switcher'
import type { SidebarUser } from './sidebar-user-menu'

export interface AppShellRailProps {
  projects: ProjectSwitcherProject[]
  user?: SidebarUser
  organizationName?: string | null
  authRequired: boolean
  canManageOrganization: boolean
  canViewOrganization: boolean
  canManagePlatform: boolean
  canAccessArchiv: boolean
  canAccessInbox: boolean
  showSkills: boolean
  showModels: boolean
}

export function AppShellRail(props: AppShellRailProps): JSX.Element {
  const pathname = usePathname() ?? ''
  const projectId = projectIdFromPathname(pathname)

  return (
    <AppSidebar
      scope={projectId ? 'project' : 'org'}
      projectId={projectId}
      projects={props.projects}
      user={props.user}
      organizationName={props.organizationName}
      authRequired={props.authRequired}
      canManageOrganization={props.canManageOrganization}
      canViewOrganization={props.canViewOrganization}
      canManagePlatform={props.canManagePlatform}
      canAccessArchiv={props.canAccessArchiv}
      canAccessInbox={props.canAccessInbox}
      showSkills={props.showSkills}
      showModels={props.showModels}
    />
  )
}
