'use client'

import { type ReactNode, Suspense, useEffect } from 'react'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { useChatStore } from '@/features/chat'

export interface WorkspaceChatClientProps {
  /** Whether report source lines show origin badges (WorkOS `source-origin-badges`). */
  showSourceBadges: boolean
  /** Whether shallow answers show the confidence chip (WorkOS `chat-confidence-chip`). */
  showConfidenceChip: boolean
  /** Whether answers show the per-answer thumbs row (WorkOS `answer-feedback`, WS-7). */
  showAnswerFeedback: boolean
  /**
   * Whether the sessions panel shows per-session research labels (WorkOS
   * `research-in-chat-history`, FB-10). The Deep Research SECTION is off in the
   * Büro whatever this says — it is scoped by a project's collection, and the
   * office has none until phase 5 (`MainLayout`).
   */
  showResearchInHistory: boolean
}

const WorkspaceChatContent = ({
  showSourceBadges,
  showConfidenceChip,
  showAnswerFeedback,
  showResearchInHistory,
}: WorkspaceChatClientProps): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()
  const setScope = useChatStore((s) => s.setScope)
  const loadServerConversations = useChatStore((s) => s.loadServerConversations)

  useEffect(() => {
    // Order matters: the scope goes in first (it clears the project and drops a
    // project thread that must not continue here), and only then is the list
    // asked for — `loadServerConversations` reads the scope to decide which
    // rows it wants.
    setScope('workspace')
    void loadServerConversations()
    // Back to the default on the way out. The store outlives this route, so a
    // scope left set would make the next project chat ask the server for
    // workspace rows and show none of the project's own.
    return () => setScope('project')
  }, [setScope, loadServerConversations])

  return (
    <MainLayout
      isAuthenticated={isAuthenticated}
      onSignIn={signIn}
      showSourceBadges={showSourceBadges}
      showConfidenceChip={showConfidenceChip}
      showAnswerFeedback={showAnswerFeedback}
      showResearchInHistory={showResearchInHistory}
      // No projectId, no projectCollection, and no project name: the scope chip
      // and the breadcrumb read "Büro" from the store's scope instead
      // (`MainLayout`). Collaboration stays off — a workspace conversation is
      // private-only in phase 1 and the service refuses to widen it, so the
      // Share entry must not be offered (`workspace-chat-ui.md` §7).
    />
  )
}

/**
 * Client half of the Büro — the organization-level chat at `/app/chat`
 * (ADR-0054, `workspace-chat-ui.md` §2).
 *
 * A SIBLING of `project-chat-client.tsx`, not a widened version of it. The two
 * render the same `MainLayout` from the same store, and what separates them is
 * exactly one fact: this one has no project, and says so. Keeping
 * `ProjectChatClientProps.projectId` required is what makes that fact
 * structural — an optional project id would let a project chat mount with none
 * and retrieve against whatever the store happened to hold.
 */
export const WorkspaceChatClient = (props: WorkspaceChatClientProps): ReactNode => {
  return (
    <Suspense fallback={null}>
      <WorkspaceChatContent {...props} />
    </Suspense>
  )
}

export default WorkspaceChatClient
