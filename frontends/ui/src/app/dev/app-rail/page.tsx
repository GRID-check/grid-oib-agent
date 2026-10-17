'use client'

/**
 * App-rail dev preview: renders the REAL `AppSidebar` on its own, in both the
 * expanded and the COLLAPSED (icon) state, so the rail itself can be reviewed
 * and screenshotted. Not linked anywhere
 * and 404s outside development.
 *
 * Why this exists. The rail was only ever captured incidentally, as the
 * backdrop of `/dev/sessions`, and that preview always renders it EXPANDED —
 * every Playwright context is a fresh profile, so the collapsed state (which
 * lives in `localStorage`) was never reachable and therefore never reviewed.
 * The icon rail is a different layout, not a narrower one: labels go `sr-only`,
 * group labels unmount, tiles switch to a square hit area. None of that had
 * visual evidence, which is how its geometry drifted unnoticed.
 *
 * How the collapsed state is forced. `AppSidebar` mounts its own
 * `SidebarProvider` and does not expose `defaultOpen`, so the only seam is the
 * storage key the provider restores from (`grid.sidebar.collapsed`, read in an
 * effect at `components/ui/sidebar.tsx`). The seed therefore runs at MODULE
 * SCOPE — the same reason the fetch shims elsewhere in `/dev` do: React runs a
 * child's effects before its parent's, so anything deferred to a component
 * effect would land after the provider has already restored. Browser- and
 * development-only, and idempotent.
 *
 * Variants via `?variant=`:
 *   - default     — the expanded 236px rail.
 *   - `collapsed` — the 64px icon rail.
 *   - `wide`      — the rail dragged out to 400px, which is now a state a
 *     reader can put it in: the edge is a real resize handle, and a width the
 *     reader chose is the width every later session opens at. Same seam,
 *     nav column and footer edge as the default shot, at a width the design
 *     was never reviewed at.
 *
 * Below `md` the same page is the PHONE shell: the rail's top band (project
 * pill, search), a content stand-in, and the bottom tab bar, lit for Dateien.
 * Two more states for the phone, via `?open=`:
 *   - `drawer`   — "Mehr" pressed: the rail as a drawer over the page.
 *   - `switcher` — the project pill pressed: the switcher sheet.
 */

import type { JSX } from 'react'
import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { AppSidebar } from '@/components/shell/app-sidebar'
import { PhoneTabBar } from '@/components/shell/phone-tab-bar'
import { ProjectSwitcherSheet } from '@/components/shell/project-switcher-sheet'
import { recordRecentProject } from '@/components/shell/recent-projects'
import { useShellOverlays } from '@/components/shell/shell-overlays'
import { useLayoutStore } from '@/features/layout/store'
import { installInboxBadgeFake } from '../_fixtures/inbox-badge'

const SIDEBAR_STORAGE_KEY = 'grid.sidebar.collapsed'
const SIDEBAR_WIDTH_STORAGE_KEY = 'grid.sidebar.width'
/** The `wide` variant's width — near the rail's 420px ceiling, not at it. */
const WIDE_WIDTH = 400

// Module scope, not an effect — see the header note. Reads the variant from the
// URL directly because `useSearchParams` is only available during render, which
// is already too late for the provider's restore effect.
// The badge shows a count, as it does for anyone with something waiting.
installInboxBadgeFake(3)

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  try {
    const variant = new URLSearchParams(window.location.search).get('variant')
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(variant === 'collapsed'))
    // Seeded the same way and for the same reason as the collapse: the width
    // lives in localStorage and the provider restores it in an effect, so a
    // component-effect seed would land after the restore has already run.
    if (variant === 'wide') window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(WIDE_WIDTH))
    else window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
  } catch {
    // Storage unavailable — the rail falls back to its expanded default, which
    // still renders a valid (if off-variant) preview rather than nothing.
  }
}

const PROJECTS = [
  { id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' },
  { id: 'p-2', name: 'Sanierung Amtshaus Favoriten' },
  { id: 'p-3', name: 'Volksschule Mühlgasse', status: 'paused' as const },
  { id: 'p-4', name: 'Bürohaus Lände 3' },
  { id: 'p-5', name: 'Kindergarten Stammersdorf' },
  { id: 'p-6', name: 'Dachausbau Kaiserstraße 12' },
]

/** The tab the phone preview lights: the page the stand-in is pretending to be. */
const PREVIEW_PATH = '/app/projects/p-1/files'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // A week on site: the reader came here from two other projects.
  recordRecentProject('p-4')
  recordRecentProject('p-2')
  recordRecentProject('p-1')
}

export default function AppRailPreview(): JSX.Element {
  const params = useSearchParams()
  const variant = params?.get('variant') ?? 'default'
  const open = params?.get('open')
  const setDrawerOpen = useLayoutStore((s) => s.setMobileNavOpen)
  const setSheetOpen = useShellOverlays((s) => s.setProjectSheetOpen)

  // After the rail's own route-change reset (it closes the drawer on mount).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (open === 'drawer') setDrawerOpen(true)
      if (open === 'switcher') setSheetOpen(true)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [open, setDrawerOpen, setSheetOpen])

  return (
    <div
      className="bg-background text-foreground flex h-dvh flex-col overflow-hidden md:flex-row"
      data-testid="app-rail-preview"
      data-variant={variant}
    >
      {/* `contents` keeps the rail a direct flex child of the shell row, the
          way the shell hosts it: the desktop rail at `md`, the phone's top band
          and drawer below. */}
      <div className="contents">
        <AppSidebar
          projectId="p-1"
          projects={PROJECTS}
          user={{ name: 'Anna Berger', email: 'anna.berger@example.at' }}
          organizationName="Musterarchitektur ZT GmbH"
          authRequired={false}
          // Every gated entry on, so the shot shows the rail at FULL height —
          // the footer-clipping and group-rhythm defects only surface when the
          // nav column is long enough to compete for vertical space.
          canViewOrganization
          canManageOrganization
          canManagePlatform
          canAccessArchiv
          canAccessInbox
          showModels
          showSkills
        />
      </div>

      {/* Content stand-in: the rail is the subject, but it is only honest to
          judge its edge against the surface it actually borders. */}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden p-6">
        <p className="text-muted-foreground font-mono text-xs">
          /dev/app-rail —{' '}
          {variant === 'collapsed'
            ? 'collapsed icon rail (64px)'
            : variant === 'wide'
              ? `rail dragged to ${WIDE_WIDTH}px`
              : 'expanded rail (236px)'}
          <span className="md:hidden"> · phone: tab bar lit for {PREVIEW_PATH}</span>
        </p>
      </main>
      <PhoneTabBar projectId="p-1" canAccessArchiv canAccessInbox pathname={PREVIEW_PATH} />
      <ProjectSwitcherSheet projects={PROJECTS} activeProjectId="p-1" />
    </div>
  )
}
