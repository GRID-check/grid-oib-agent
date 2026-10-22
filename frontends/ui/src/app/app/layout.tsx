/**
 * /app layout — the authenticated application shell.
 *
 * Deliberately thin: it only mounts cross-cutting client affordances that
 * must exist on every /app page. Today that is the keyboard-shortcuts
 * feature (command palette, global hotkeys, cheatsheet), mounted for every
 * session with an organization. The per-user preference is enforced inside the
 * client component itself. The same goes for the notification worker's
 * lifecycle (Web Push, ADR-0112) and the offer to turn notifications on.
 *
 * Session reading is tolerant (no redirects): each page below still does its
 * own auth guard, and pages like onboarding must render without an org.
 */

import type { JSX } from 'react'
import { type ReactNode } from 'react'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { isInboundMailEnabled, isProjectKnowledgePageEnabled, isSkillsEnabled } from '@/lib/authz/feature-flags'
import { getNavFlags } from '@/lib/authz/nav'
import { KeyboardShortcuts } from '@/components/shell'
import { isAuthRequired } from '@/lib/auth/auth-required'
import { PushLifecycle } from '@/features/notifications/components/push-lifecycle'
import { InboxPushOffer } from '@/features/notifications/components/inbox-push-offer'
import { getPushConfig } from '@/lib/push/service'


interface AppLayoutProps {
  children: ReactNode
}

export default async function AppLayout({ children }: AppLayoutProps): Promise<JSX.Element> {
  return runWithTenantSlot(async () => {
    let shortcuts: ReactNode = null
    let notifications: ReactNode = null
    try {
      const session = await getGridSession()
      // Users without an org (onboarding) have nowhere for the palette to
      // navigate, so they get no shortcuts surface at all.
      if (session?.organizationId) {
        // Same section flags the project rail receives, so ⌘K's current-project
        // commands stay in lock-step with the rail (shared PROJECT_SECTIONS).
        const navFlags = await getNavFlags(session)
        // The notification worker, after sign-in and only where the deployment
        // has the keys for it (ADR-0112). Never for a visitor without a session.
        // The offer to turn them on, made once in the shell when something
        // first waits on the person, for whoever never opens the inbox.
        const pushEnabled = getPushConfig().enabled
        notifications = (
          <>
            <PushLifecycle enabled={pushEnabled} />
            {pushEnabled && navFlags.canAccessInbox && <InboxPushOffer enabled />}
          </>
        )
        shortcuts = (
          <KeyboardShortcuts
            authRequired={isAuthRequired()}
            // Every authenticated org member may open the organization page
            // (it serves capability subsets, see getNavFlags / UX-16).
            canViewOrganization
            showKnowledge={isProjectKnowledgePageEnabled(session)}
            showSkills={isSkillsEnabled(session)}
            canAccessOfficeShelf={navFlags.canAccessOfficeShelf}
            canCollaborate={navFlags.canCollaborate}
            canAccessInbox={navFlags.canAccessInbox}
            inboundMail={isInboundMailEnabled(session)}
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
        {notifications}
      </>
    )
  })
}
