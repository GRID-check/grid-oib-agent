import { type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { ORG_PERMISSIONS, hasPermission } from '@/lib/authz/permissions'
import { WorkspaceChatClient } from './workspace-chat-client'

interface ChatRedirectPageProps {
  searchParams: Promise<{ session?: string }>
}

/**
 * Resolve the project chat URL for a conversation this reader may open.
 *
 * The project id is part of the answer, so it is only resolved for someone
 * entitled to the conversation: `viewer` is the least a reader of the thread
 * must hold, and `requireResourceAccess` answers `NotFoundError` for "missing"
 * and "not yours" alike (spec SH-6), so a probe learns nothing either way.
 * Every failure degrades to `null` — the caller sends the reader to their
 * projects rather than an error screen. That includes the signed-out and
 * no-organization cases, which is why the session comes from the API-safe
 * `requireAuthorizedSession` (it throws) rather than the page variant (it
 * redirects, and a redirect thrown in here would be caught below).
 */
async function resolveChatTarget(conversationId: string): Promise<string | null> {
  try {
    // Own tenant slot: a server component gets none from a route factory, and
    // the session publish alone does not survive the render (#342, #344).
    return await runWithTenantSlot(async () => {
      const session = await requireAuthorizedSession()
      const tenancy = await findConversationTenancy(conversationId)
      if (!tenancy?.projectId) return null
      await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
      return `/app/projects/${encodeURIComponent(tenancy.projectId)}/chat?session=${encodeURIComponent(conversationId)}`
    })
  } catch {
    return null
  }
}

/**
 * `/app/chat` — the Büro (ADR-0054), and the resolver for inbox deep links to
 * conversations that have no project.
 *
 * The deep-link branch is unchanged and runs FIRST (WS-14): a shareable
 * conversation is always reached through its project's chat surface, and the
 * inbox can only emit that URL when it knows the project. For the rare
 * org-level target it emits `/app/chat?session=<id>` instead (see the
 * conversation descriptor's `deepLink`), which this route resolves to the same
 * shape and redirects. Without it, an inbox row for such a conversation died on
 * a 404 the moment the recipient clicked it.
 *
 * What is new is where an UNRESOLVED link lands. A conversation with no project
 * is now a first-class workspace row rather than an anomaly, so with the flag on
 * the address renders the Büro and its own session restore picks the thread up
 * from the `?session=` still in the URL. Without the flag the page behaves
 * exactly as it did — every path ends at `/app/projects` (WS-15).
 *
 * The redirect happens OUTSIDE the resolution's try/catch: `redirect()` reports
 * itself by throwing, so a `catch` around it would swallow the navigation and
 * send every deep link to the projects page instead.
 */
const ChatPage = async ({ searchParams }: ChatRedirectPageProps): Promise<ReactNode> => {
  const { session } = await searchParams
  const target = session ? await resolveChatTarget(session) : null
  if (target) redirect(target)

  // Own tenant slot, and the same fail-open flag reads the project chat page
  // does: a session-lookup problem degrades an affordance, never the surface.
  // `workspaceChat` is the exception and fails CLOSED — without a session there
  // is no organization to have the flag, and the Büro is the flagged surface
  // itself rather than a detail on one.
  const chrome = await runWithTenantSlot(async () => {
    try {
      const gridSession = await getGridSession()
      if (!gridSession) return null
      if (!isFeatureEnabled(gridSession, FEATURE_FLAGS.workspaceChat)) return null
      // The same door the conversations service holds (spec AC-1): a member
      // whose role withholds `org:chat` is sent to their projects here, rather
      // than reaching a Büro whose every list call would 403 into silence.
      if (!hasPermission(gridSession, ORG_PERMISSIONS.chat)) return null
      return {
        showSourceBadges: isFeatureEnabled(gridSession, FEATURE_FLAGS.sourceOriginBadges),
        showConfidenceChip: isFeatureEnabled(gridSession, FEATURE_FLAGS.chatConfidenceChip),
        showAnswerFeedback: isFeatureEnabled(gridSession, FEATURE_FLAGS.answerFeedback),
        showResearchInHistory: isFeatureEnabled(gridSession, FEATURE_FLAGS.researchInChatHistory),
      }
    } catch {
      return null
    }
  })

  if (!chrome) redirect('/app/projects')

  return (
    <WorkspaceChatClient
      showSourceBadges={chrome.showSourceBadges}
      showConfidenceChip={chrome.showConfidenceChip}
      showAnswerFeedback={chrome.showAnswerFeedback}
      showResearchInHistory={chrome.showResearchInHistory}
    />
  )
}

export default ChatPage
