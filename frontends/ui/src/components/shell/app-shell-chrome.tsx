'use client'

/**
 * The app chrome, mounted ONCE for the whole authenticated app.
 *
 * This component is the reason the chrome stops flickering. It lives in the
 * `(shell)` layout — the common ancestor of every authenticated surface — and
 * Next.js does not re-render a layout on navigation, so React never unmounts
 * it. Scope is read from the pathname rather than passed down: a prop would
 * have to come from a server segment, and the only segment that knows a project
 * id is the one BELOW this layout — precisely the segment whose remount was the
 * original bug. A parallel route (`@rail`) was considered and rejected for the
 * chrome itself: a catch-all slot re-renders on every navigation, which
 * destroys exactly the persistence this exists for. (The `@overlay` slot the
 * layout DOES pass through is different: it renders a sheet, not the chrome,
 * and re-rendering a sheet on navigation is its job.)
 *
 * TWO SCOPES, TWO SHAPES. Inside a project the chrome is the 236px rail
 * (`AppSidebar`) — a project has sections to navigate. Above a project it is a
 * slim header (`OrgHeader`) and the page gets the full width: the org scope's
 * one real surface is the projects home, and its other destinations are sheets
 * or avatar-menu entries. Crossing the boundary swaps the chrome once, on
 * purpose; within a scope nothing moves.
 *
 * OVERLAY ROUTES KEEP THE CHROME OF THE PAGE THEY COVER. The Archiv and the
 * Postfach are intercepted routes: a soft navigation to `/app/archiv` changes
 * the URL while the segment below keeps rendering the page the reader was on.
 * Deriving scope from the raw pathname would flip a project's rail into the
 * org header UNDER the sheet — the reflow this file exists to prevent — so
 * while an overlay route is active, scope sticks to the last solid (covered)
 * pathname. On a hard load of an overlay URL there is no covered page and the
 * org header stands behind the sheet.
 */

import * as React from 'react'
import type { JSX } from 'react'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'
import { AppSidebar } from './app-sidebar'
import { OrgHeader } from './org-header'
import { projectIdFromPathname } from './org-sections'
import type { ProjectSwitcherProject } from './project-switcher'
import type { SidebarUser } from './sidebar-user-menu'

const OVERLAY_ROUTES = ['/app/archiv', '/app/inbox'] as const

function isOverlayPath(pathname: string): boolean {
  return OVERLAY_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

export interface AppShellChromeProps {
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
  /** The `(shell)` layout's `<main>` (with the page inside). */
  children: React.ReactNode
  /** The `@overlay` parallel slot — the Archiv/Postfach sheet, or null. */
  overlay: React.ReactNode
}

export function AppShellChrome({
  children,
  overlay,
  ...chrome
}: AppShellChromeProps): JSX.Element {
  const pathname = usePathname() ?? ''

  // The last non-overlay pathname — the page the sheet covers. A ref written
  // during render is the standard previous-value idiom; the write is
  // idempotent, so strict mode's double render lands on the same value.
  const solidPathRef = React.useRef(isOverlayPath(pathname) ? '/app/projects' : pathname)
  if (!isOverlayPath(pathname)) solidPathRef.current = pathname

  const projectId = projectIdFromPathname(solidPathRef.current)
  const inProject = projectId !== null

  return (
    <div
      className={cn(
        'bg-background text-foreground flex h-dvh overflow-hidden',
        inProject ? 'flex-col md:flex-row' : 'flex-col',
      )}
    >
      {inProject ? (
        <AppSidebar
          projectId={projectId}
          projects={chrome.projects}
          user={chrome.user}
          organizationName={chrome.organizationName}
          authRequired={chrome.authRequired}
          canManageOrganization={chrome.canManageOrganization}
          canViewOrganization={chrome.canViewOrganization}
          canManagePlatform={chrome.canManagePlatform}
          canAccessArchiv={chrome.canAccessArchiv}
          canAccessInbox={chrome.canAccessInbox}
          showSkills={chrome.showSkills}
          showModels={chrome.showModels}
        />
      ) : (
        <OrgHeader
          user={chrome.user}
          organizationName={chrome.organizationName}
          authRequired={chrome.authRequired}
          canManageOrganization={chrome.canManageOrganization}
          canViewOrganization={chrome.canViewOrganization}
          canManagePlatform={chrome.canManagePlatform}
          canAccessArchiv={chrome.canAccessArchiv}
          canAccessInbox={chrome.canAccessInbox}
        />
      )}
      {children}
      {overlay}
    </div>
  )
}
