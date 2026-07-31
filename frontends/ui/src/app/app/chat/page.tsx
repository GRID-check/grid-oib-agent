import { type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getGridSession } from '@/lib/auth/session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'

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
 * projects rather than an error screen.
 */
async function resolveChatTarget(conversationId: string): Promise<string | null> {
  try {
    const user = await getGridSession()
    if (!user?.organizationId) return null
    const tenancy = await findConversationTenancy(conversationId)
    if (!tenancy?.projectId) return null
    await requireResourceAccess(
      user as AuthorizedSession,
      'conversation',
      conversationId,
      'viewer',
    )
    return `/app/projects/${encodeURIComponent(tenancy.projectId)}/chat?session=${encodeURIComponent(conversationId)}`
  } catch {
    return null
  }
}

/**
 * Resolves inbox deep links for container-less conversations.
 *
 * A shareable conversation is always reached through its project's chat surface,
 * and the inbox can only emit that URL when it knows the project. For the rare
 * org-level target it emits `/app/chat?session=<id>` instead (see the
 * conversation descriptor's `deepLink`), which this route resolves to the same
 * shape and redirects. Without it, an inbox row for such a conversation died on
 * a 404 the moment the recipient clicked it.
 *
 * The redirect happens OUTSIDE the resolution's try/catch: `redirect()` reports
 * itself by throwing, so a `catch` around it would swallow the navigation and
 * send every deep link to the projects page instead.
 */
const ChatRedirectPage = async ({ searchParams }: ChatRedirectPageProps): Promise<ReactNode> => {
  const { session } = await searchParams
  const target = session ? await resolveChatTarget(session) : null
  redirect(target ?? '/app/projects')
}

export default ChatRedirectPage
