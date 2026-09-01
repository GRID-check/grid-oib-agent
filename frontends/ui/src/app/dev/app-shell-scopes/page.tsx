'use client'

/**
 * App-shell scopes dev preview: the two chromes, side by side
 * (visual/registry.mjs → `app-shell-scopes`). Not linked anywhere and 404s
 * outside development.
 *
 * Why it exists. Since the org-nav redesign the two scopes deliberately have
 * different SHAPES: inside a project the chrome is the 236px rail; above a
 * project it is a slim full-width header and the page gets the whole width.
 * That is a claim about two states that never appear at the same moment in the
 * product, so the only way to review the pair — the rail's geometry, the
 * header's height, where the avatar and the inbox badge sit in each — is to
 * put them next to each other.
 *
 * Two chromes on one page needs one trick. `sidebar-container` is
 * `position: fixed; left: 0`, so two of them would stack on top of each other at
 * the viewport's left edge. Each column therefore carries a `transform`, which
 * makes it the containing block for its own fixed descendants — the rail then
 * pins to its column instead of to the viewport.
 */

import type { JSX } from 'react'
import { AppSidebar } from '@/components/shell/app-sidebar'
import { OrgHeader } from '@/components/shell/org-header'

const PROJECTS = [
  { id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' },
  { id: 'p-2', name: 'Sanierung Amtshaus Favoriten' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  try {
    // Both columns restore collapse from the same key; pin the rail expanded so
    // the comparison is between SCOPES and not between collapse states.
    window.localStorage.setItem('grid.sidebar.collapsed', 'false')
  } catch {
    // Storage unavailable — the rail renders expanded by default anyway.
  }
}

const CHROME_FLAGS = {
  user: { name: 'Anna Berger', email: 'anna.berger@example.at' },
  organizationName: 'Musterarchitektur ZT GmbH',
  authRequired: false,
  canViewOrganization: true,
  canManageOrganization: true,
  canManagePlatform: true,
  canAccessArchiv: true,
  canAccessInbox: true,
} as const

function ScopeColumn({
  caption,
  row,
  children,
}: {
  caption: string
  /** Rail scope lays the column out as a row; header scope stacks it. */
  row: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      // `transform` (not just `relative`) — see the header note: it makes this
      // column the containing block for the rail's `position: fixed` body.
      style={{ transform: 'translateZ(0)' }}
      className={`border-border relative flex h-dvh min-w-0 flex-1 overflow-hidden border-l first:border-l-0 ${row ? '' : 'flex-col'}`}
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
      <ScopeColumn row caption="project scope — /app/projects/p-1/files">
        <AppSidebar projectId="p-1" projects={PROJECTS} showModels showSkills {...CHROME_FLAGS} />
      </ScopeColumn>
      <ScopeColumn row={false} caption="org scope — /app/projects">
        <OrgHeader {...CHROME_FLAGS} />
      </ScopeColumn>
    </div>
  )
}
