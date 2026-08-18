'use client'

/**
 * App-rail dev preview: renders the REAL `AppSidebar` on its own, in both the
 * expanded and the COLLAPSED (icon) state, so the rail itself can be reviewed
 * and screenshotted (visual/registry.mjs → `app-rail*`). Not linked anywhere
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
 */

import { useSearchParams } from 'next/navigation'
import { AppSidebar } from '@/components/shell/app-sidebar'

const SIDEBAR_STORAGE_KEY = 'grid.sidebar.collapsed'

// Module scope, not an effect — see the header note. Reads the variant from the
// URL directly because `useSearchParams` is only available during render, which
// is already too late for the provider's restore effect.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  try {
    const collapsed = new URLSearchParams(window.location.search).get('variant') === 'collapsed'
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed))
  } catch {
    // Storage unavailable — the rail falls back to its expanded default, which
    // still renders a valid (if off-variant) preview rather than nothing.
  }
}

const PROJECTS = [
  { id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' },
  { id: 'p-2', name: 'Sanierung Amtshaus Favoriten' },
]

export default function AppRailPreview(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'default'

  return (
    <div
      className="bg-background text-foreground flex h-dvh flex-col overflow-hidden md:flex-row"
      data-testid="app-rail-preview"
      data-variant={variant}
    >
      {/* `md:contents` keeps the rail a direct flex child of the shell row on
          desktop, matching how the project layout hosts it. Hidden below `md`,
          where the rail is replaced by the mobile bar. */}
      <div className="hidden md:contents">
        <AppSidebar
          projectId="p-1"
          projects={PROJECTS}
          user={{ name: 'Anna Berger', email: 'anna.berger@example.at' }}
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
      <main className="min-w-0 flex-1 overflow-hidden p-6">
        <p className="text-muted-foreground font-mono text-xs">
          /dev/app-rail — {variant === 'collapsed' ? 'collapsed icon rail (64px)' : 'expanded rail (236px)'}
        </p>
      </main>
    </div>
  )
}
