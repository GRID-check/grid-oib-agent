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
 * ON A PHONE the chrome has a second half: the bottom tab bar
 * (`PhoneTabBar`), mounted after `<main>` so it sits in flow under the page
 * rather than over it, and the project switcher sheet its header opens.
 *
 * OVERLAY ROUTES KEEP THE CHROME OF THE PAGE THEY COVER. The Archiv and the
 * Postfach are intercepted routes: a soft navigation to `/app/office-shelf` changes
 * the URL while the segment below keeps rendering the page the reader was on.
 * Deriving scope from the raw pathname would flip a project's rail into the
 * org header UNDER the sheet — the reflow this file exists to prevent — so
 * while an overlay route is active, scope sticks to the last solid (covered)
 * pathname. On a hard load of an overlay URL there is no covered page and the
 * org header stands behind the sheet.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { usePathname } from 'next/navigation'

import { ProductTour } from '@/features/onboarding/components/product-tour'
import { FeedbackProvider } from '@/features/product-feedback/components'
import { useVisualViewport } from '@/hooks/use-visual-viewport'
import { cn } from '@/lib/utils'
import { AppSidebar } from './app-sidebar'
import { OrgHeader } from './org-header'
import { projectIdFromPathname } from './org-sections'
import { PhoneMoreSheet } from './phone-more-sheet'
import { PhoneTabBar } from './phone-tab-bar'
import { phoneTabBarHiddenOnRoute } from './phone-tabs'
import { ProjectSwitcherSheet } from './project-switcher-sheet'
import { useKeyboardUp } from './use-keyboard-up'
import type { ProjectSwitcherProject } from './project-switcher'
import type { SidebarUser } from './sidebar-user-menu'
import type { TourEligibility } from '@/features/onboarding/lib/product-tour'

// `/app/uploads/<id>` is the upload summary's dialog (ADR-0086), opened from
// the Postfach over the page the reader was on.
const OVERLAY_ROUTES = ['/app/office-shelf', '/app/inbox', '/app/uploads'] as const

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
  canAccessOfficeShelf: boolean
  canAccessInbox: boolean
  showSkills: boolean
  showModels: boolean
  /** The office receives project mail: Dateien carries the waiting count (ADR-0134). Absent: off. */
  inboundMail?: boolean
  /** Which product tours start by themselves for this reader. */
  tours: TourEligibility
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

  // iOS ignores `interactive-widget`, so the shell follows the visual viewport
  // itself while the keyboard is up (see the hook). Mounted here because this
  // is the one component that lives for the whole authenticated app.
  useVisualViewport()

  // The phone tab bar stands down while the keyboard is up and on the intake
  // wizard (see `PhoneTabBar`). Decided here, not in the bar, because the
  // frame publishes the result to the page below: `--shell-inset-bottom` is
  // the home-indicator inset a surface at the bottom of `<main>` still has to
  // clear. Zero while the bar stands (the bar clears it) and while the
  // keyboard is up (it covers the indicator); the real inset otherwise.
  const keyboardUp = useKeyboardUp()
  const tabBarShown = !keyboardUp && !phoneTabBarHiddenOnRoute(solidPathRef.current)

  return (
    <ProductTour
      canAccessOfficeShelf={chrome.canAccessOfficeShelf}
      canAccessInbox={chrome.canAccessInbox}
      canManageOrganization={chrome.canManageOrganization}
      eligible={chrome.tours}
    >
    <FeedbackProvider userEmail={chrome.user?.email ?? null}>
    <div
      data-tab-bar={tabBarShown ? 'shown' : 'hidden'}
      data-keyboard={keyboardUp ? 'up' : undefined}
      className={cn(
        // The space above the keyboard while one is up on iOS (the variable
        // is set only then, by useVisualViewport), the dynamic viewport
        // otherwise. Safe-area insets stay per surface (app/layout.tsx).
        'bg-background text-foreground flex h-[var(--visual-viewport-height,100dvh)] overflow-hidden',
        inProject ? 'flex-col md:flex-row' : 'flex-col',
        '[--shell-inset-bottom:env(safe-area-inset-bottom)] data-[keyboard=up]:[--shell-inset-bottom:0px] max-md:data-[tab-bar=shown]:[--shell-inset-bottom:0px]',
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
          canAccessOfficeShelf={chrome.canAccessOfficeShelf}
          canAccessInbox={chrome.canAccessInbox}
          showSkills={chrome.showSkills}
          showModels={chrome.showModels}
          inboundMailEnabled={chrome.inboundMail}
        />
      ) : (
        <OrgHeader
          user={chrome.user}
          organizationName={chrome.organizationName}
          authRequired={chrome.authRequired}
          canManageOrganization={chrome.canManageOrganization}
          canViewOrganization={chrome.canViewOrganization}
          canManagePlatform={chrome.canManagePlatform}
          canAccessOfficeShelf={chrome.canAccessOfficeShelf}
          canAccessInbox={chrome.canAccessInbox}
        />
      )}
      {children}
      {tabBarShown && (
        <PhoneTabBar
          projectId={projectId}
          canAccessOfficeShelf={chrome.canAccessOfficeShelf}
          canAccessInbox={chrome.canAccessInbox}
          inboundMailEnabled={chrome.inboundMail}
        />
      )}
      {inProject && tabBarShown && (
        <PhoneMoreSheet
          projectId={projectId}
          authRequired={chrome.authRequired}
          canAccessOfficeShelf={chrome.canAccessOfficeShelf}
          canAccessInbox={chrome.canAccessInbox}
          showSkills={chrome.showSkills}
          canViewOrganization={chrome.canViewOrganization}
          canManageOrganization={chrome.canManageOrganization}
          canManagePlatform={chrome.canManagePlatform}
        />
      )}
      {inProject && <ProjectSwitcherSheet projects={chrome.projects} activeProjectId={projectId} />}
      {overlay}
    </div>
    </FeedbackProvider>
    </ProductTour>
  )
}
