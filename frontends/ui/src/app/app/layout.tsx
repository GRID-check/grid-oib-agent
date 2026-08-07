/**
 * /app layout — the authenticated application shell.
 *
 * Deliberately thin: it only mounts cross-cutting client affordances that
 * must exist on every /app page. Today that is the keyboard-shortcuts
 * feature (command palette, global hotkeys, cheatsheet), gated here at the
 * organization level via the `keyboard-shortcuts` WorkOS feature flag — no
 * flag, no client component, zero listeners. The per-user preference is
 * enforced inside the client component itself.
 *
 * Session reading is tolerant (no redirects): each page below still does its
 * own auth guard, and pages like onboarding must render without an org.
 */

import { type ReactNode } from 'react'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  isProjectKnowledgePageEnabled,
  isWorkflowsEnabled,
} from '@/lib/authz/feature-flags'
import { getNavFlags } from '@/lib/authz/nav'
import { KeyboardShortcuts } from '@/components/shell'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

interface AppLayoutProps {
  children: ReactNode
}

export default async function AppLayout({ children }: AppLayoutProps): Promise<JSX.Element> {
  return runWithTenantSlot(async () => {
    let shortcuts: ReactNode = null
    try {
      const session = await getGridSession()
      // Org-level (outer) gate: only sessions whose org has the feature flag
      // get the shortcuts surface at all. Users without an org (onboarding)
      // have nowhere for the palette to navigate — skip it for them too.
      if (session?.organizationId && isFeatureEnabled(session, FEATURE_FLAGS.keyboardShortcuts)) {
        // Same section flags the project rail receives, so ⌘K's current-project
        // commands stay in lock-step with the rail (shared PROJECT_SECTIONS).
        const navFlags = await getNavFlags(session)
        shortcuts = (
          <KeyboardShortcuts
            authRequired={isAuthRequired()}
            // Every authenticated org member may open the organization page
            // (it serves capability subsets, see getNavFlags / UX-16).
            canViewOrganization
            showKnowledge={isProjectKnowledgePageEnabled(session)}
            showWorkflows={isWorkflowsEnabled(session)}
            canAccessArchiv={navFlags.canAccessArchiv}
            canCollaborate={navFlags.canCollaborate}
            canAccessInbox={navFlags.canAccessInbox}
          />
        )
      }
    } catch {
      // Session lookup failed — pages handle auth themselves; just skip the
      // shortcuts layer rather than breaking the whole /app subtree.
    }

    return (
      <>
        {children}
        {shortcuts}
      </>
    )
  })
}
