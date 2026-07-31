import { type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getGridSession } from '@/lib/auth/session'
import { findConversationTenancy } from '@/lib/conversations/repository'

interface ChatRedirectPageProps {
  searchParams: Promise<{ session?: string }>
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
 * The link is only ever produced after read-time re-authorization, so reaching
 * here means the target was valid moments ago; a failure still degrades to the
 * projects page rather than an error screen.
 */
const ChatRedirectPage = async ({ searchParams }: ChatRedirectPageProps): Promise<ReactNode> => {
  const { session } = await searchParams
  if (session) {
    try {
      const user = await getGridSession()
      const tenancy = user ? await findConversationTenancy(session) : null
      if (tenancy?.projectId) {
        redirect(`/app/projects/${encodeURIComponent(tenancy.projectId)}/chat?session=${encodeURIComponent(session)}`)
      }
    } catch {
      // Fall through to the projects page; the chat route's own guards own the
      // access decision.
    }
  }
  redirect('/app/projects')
}

export default ChatRedirectPage
