/**
 * The persistent application frame.
 *
 * Everything the reader sees that is not the page itself lives here: the
 * chrome (project rail or org header — see {@link AppShellChrome}), the
 * `<main>` landmark, the scroll container, the route-change focus move, and
 * the `@overlay` slot that lets the Archiv and the Postfach rise as sheets
 * above the current page. It is a ROUTE GROUP layout — `(shell)` contributes
 * nothing to any URL — which is what lets its sibling segments share one frame
 * without a single link changing (`lib/navigation/app-routes.spec.ts` holds
 * that line).
 *
 * WHY THE CHROME IS HERE AND NOT LOWER. The rail used to be mounted in
 * `projects/[id]/layout.tsx`, so it existed only inside a project, and stepping
 * out of one unmounted the whole chrome mid-navigation. Mounted in the common
 * ancestor, Next.js does not re-render it on navigation, so the frame is the
 * same DOM before and after. The org↔project chrome SWAP is the one deliberate
 * exception, executed by the mounted component rather than by a remount.
 *
 * DELIBERATELY NOT A GATE. It resolves the session TOLERANTLY
 * ({@link resolveShellChrome} never throws and never redirects) because
 * `/app/platform` sits underneath it and ADR-0016 requires a break-glass owner
 * with zero org memberships to reach that page — an org-requiring redirect here
 * would lock them out of the one surface that can fix their environment. Every
 * page below still runs its own guard.
 *
 * ONE SCROLL MODEL. The frame is `h-dvh overflow-hidden`; `<main>` is
 * `min-h-0 flex-1 overflow-y-auto`. No surface below may set `min-h-dvh` — the
 * document itself never scrolls, so the scrollbar cannot appear and disappear
 * between sections. `<main id="main-content">` and `<RouteFocus />` are declared
 * exactly once, here, rather than in the eight places that each used to.
 */

import { type ReactNode } from 'react'
import { AppShellChrome } from '@/components/shell/app-shell-chrome'
import { RouteFocus } from '@/shared/components/route-focus'
import { resolveShellChrome } from '@/lib/shell/chrome'
import { runWithTenantSlot } from '@/lib/db/tenant-context'

export default async function AppShellLayout({
  children,
  overlay,
}: {
  children: ReactNode
  overlay: ReactNode
}): Promise<JSX.Element> {
  // Its own tenant slot: React renders each layout as its own entry point, so
  // a slot opened by the `/app` layout above does not survive down to here
  // (issues #342/#344 — the same bug twice).
  const chrome = await runWithTenantSlot(resolveShellChrome)

  return (
    <AppShellChrome
      projects={chrome.projects}
      user={chrome.user}
      organizationName={chrome.organizationName}
      authRequired={chrome.authRequired}
      canManageOrganization={chrome.navFlags.canManageOrganization}
      canViewOrganization={chrome.navFlags.canViewOrganization}
      canManagePlatform={chrome.navFlags.canManagePlatform}
      canAccessArchiv={chrome.navFlags.canAccessArchiv}
      canAccessInbox={chrome.navFlags.canAccessInbox}
      showSkills={chrome.showSkills}
      showModels={chrome.showModels}
      overlay={overlay}
    >
      {/* `relative` is load-bearing for the docked chat panels: they position
          against this box, so "the inner edge of the rail" is true by
          construction rather than by a CSS variable that had to be published on
          `:root` and guessed at.
          `tabIndex={-1}` makes the landmark programmatically focusable so
          RouteFocus can move focus here on client-side section changes. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="bg-background relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto outline-none"
      >
        <RouteFocus />
        {children}
      </main>
    </AppShellChrome>
  )
}
