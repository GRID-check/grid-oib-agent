'use client'

/**
 * App-shell scopes dev preview: the SAME rail, in its two scopes, side by side
 * (visual/registry.mjs → `app-shell-scopes`). Not linked anywhere and 404s
 * outside development.
 *
 * Why it exists. The whole point of the persistent shell is that stepping out of
 * a project changes the rail's CONTENTS and nothing else — no width change, no
 * header-height change, no reflow of the page beside it. That is a claim about
 * two states that never appear at the same moment in the product, so the only
 * way to review it is to put them next to each other: the top edges, the 36px
 * context slot, the group rhythm, the footer's bottom edge and the rail width
 * all have to line up across the seam, while the tint, the switcher and the
 * entries visibly do not.
 *
 * Two rails on one page needs one trick. `sidebar-container` is
 * `position: fixed; left: 0`, so two of them would stack on top of each other at
 * the viewport's left edge. Each column therefore carries a `transform`, which
 * makes it the containing block for its own fixed descendants — the rail then
 * pins to its column instead of to the viewport.
 *
 * The org rail's back control reads the tab's return trail, so the preview seeds
 * one at MODULE SCOPE (browser + development only, idempotent — the same reason
 * `/dev/app-rail` seeds `localStorage` there): the control's whole claim is that
 * it names the project the reader actually left, and a preview showing the
 * unnamed fallback would be evidence of the wrong thing.
 */

import { AppSidebar } from '@/components/shell/app-sidebar'

const PROJECTS = [
  { id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' },
  { id: 'p-2', name: 'Sanierung Amtshaus Favoriten' },
]

const TRAIL_STORAGE_KEY = 'grid.return-trail'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  try {
    window.sessionStorage.setItem(
      TRAIL_STORAGE_KEY,
      JSON.stringify([
        { path: `/app/projects/p-1/files`, label: PROJECTS[0].name },
        { path: '/dev/app-shell-scopes' },
      ])
    )
    // Both rails restore collapse from the same key; pin them expanded so the
    // comparison is between SCOPES and not between collapse states.
    window.localStorage.setItem('grid.sidebar.collapsed', 'false')
  } catch {
    // Storage unavailable — the back control falls back to its server label and
    // the rails render expanded by default. Still a valid, if duller, preview.
  }
}

const RAIL_FLAGS = {
  projects: PROJECTS,
  user: { name: 'Anna Berger', email: 'anna.berger@example.at' },
  organizationName: 'Musterarchitektur ZT GmbH',
  authRequired: false,
  canViewOrganization: true,
  canManageOrganization: true,
  canManagePlatform: true,
  canAccessArchiv: true,
  canAccessInbox: true,
  showModels: true,
  showSkills: true,
} as const

function ScopeColumn({
  caption,
  children,
}: {
  caption: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      // `transform` (not just `relative`) — see the header note: it makes this
      // column the containing block for the rail's `position: fixed` body.
      style={{ transform: 'translateZ(0)' }}
      className="border-border relative flex h-dvh min-w-0 flex-1 overflow-hidden border-l first:border-l-0"
    >
      {children}
      <main className="bg-background min-w-0 flex-1 overflow-hidden">
        <p className="text-muted-foreground p-6 font-mono text-xs">{caption}</p>
      </main>
    </div>
  )
}

export default function AppShellScopesPreview(): JSX.Element {
  return (
    <div
      className="bg-background text-foreground flex h-dvh"
      data-testid="app-shell-scopes-preview"
    >
      <ScopeColumn caption='scope="project" — /app/projects/p-1/files'>
        <AppSidebar scope="project" projectId="p-1" {...RAIL_FLAGS} />
      </ScopeColumn>
      <ScopeColumn caption='scope="org" — /app/inbox'>
        <AppSidebar scope="org" projectId={null} {...RAIL_FLAGS} />
      </ScopeColumn>
    </div>
  )
}
