'use client'

import { type ReactNode, Suspense, useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
  const ensureSession = useChatStore((s) => s.ensureSession)
  const mountProject = useChatStore((s) => s.mountProject)

  // The doorway out of a project chat: `/app/chat?mount=<projectId>`, opened by
  // the tree's "Im Büro fragen →" (`workspace-chat-ui.md` §7, flow f).
  //
  // Consumed EXACTLY ONCE and then stripped from the URL, the same guard-ref
  // pattern `?new=1` and `?ask=` already use next door — a refresh must not
  // re-mount a project the reader has since removed. On a refusal nothing is
  // mounted and the transcript carries the reason (`MountNotices`), which is
  // the difference between "we could not" and an empty chat that silently
  // answers without the project the reader came for.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const mountParam = searchParams?.get('mount') ?? null
  const consumedMountRef = useRef<string | null>(null)

  useEffect(() => {
    if (!mountParam || !isAuthenticated || consumedMountRef.current === mountParam) return
    consumedMountRef.current = mountParam

    // A mount is a row on a conversation, so there has to be one. This is the
    // ordinary first-turn case and the mounts service is written for it: the
    // conversation row is created by whichever write arrives first.
    const conversationId = ensureSession()
    if (conversationId) {
      void mountProject(conversationId, mountParam, undefined, 'fromProject')
    }

    if (pathname) {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.delete('mount')
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    }
  }, [mountParam, isAuthenticated, ensureSession, mountProject, searchParams, pathname, router])

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
