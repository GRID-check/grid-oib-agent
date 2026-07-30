'use client'

import { type ReactNode, Suspense, useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { useChatStore, useLoadJobData, useDeepResearchTitle } from '@/features/chat'
import type { ResearchPanelTab } from '@/features/layout/types'

export interface ProjectChatClientProps {
  projectId: string
  /**
   * Whether the collaboration surfaces are available (ADR-0032…0035).
   * Dark-launched, so the server page resolves it and it is prop-drilled here
   * rather than defaulting on.
   */
  canCollaborate?: boolean
  /** Whether report source lines show origin badges (WorkOS `source-origin-badges`). */
  showSourceBadges: boolean
  /** Whether shallow answers show the confidence chip (WorkOS `chat-confidence-chip`). */
  showConfidenceChip: boolean
  /** Whether answers show the per-answer thumbs row (WorkOS `answer-feedback`, WS-7). */
  showAnswerFeedback: boolean
  /**
   * Whether the sessions panel shows the Deep Research section and per-session
   * research labels (WorkOS `research-in-chat-history`, FB-10).
   */
  showResearchInHistory: boolean
  /** Qdrant collection scoping the Deep Research section's job fetch (FB-10). */
  projectCollection: string | null
  /** Project name for the thread-header breadcrumb + composer scope chip. */
  projectName: string | null
}

const ProjectChatContent = ({
  projectId,
  showSourceBadges,
  showConfidenceChip,
  showAnswerFeedback,
  showResearchInHistory,
  projectCollection,
  projectName,
  canCollaborate = false,
}: ProjectChatClientProps): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()
  const setProjectId = useChatStore((s) => s.setProjectId)
  const loadServerConversations = useChatStore((s) => s.loadServerConversations)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const startNewSessionDraft = useChatStore((s) => s.startNewSessionDraft)

  // Deep link from the project Research page: /projects/:id/chat?job=<jobId>
  // loads that job's report into the research panel. An optional &tab= selects
  // which panel tab to open — failed runs deep-link to `thinking` so the run
  // can be diagnosed even though it has no report.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const jobId = searchParams?.get('job') ?? null
  const tabParam = searchParams?.get('tab')
  const jobTab: ResearchPanelTab =
    tabParam === 'thinking' || tabParam === 'tasks' ? tabParam : 'report'
  const { loadResearchPanelTab } = useLoadJobData()
  const loadedJobRef = useRef<string | null>(null)

  // While a deep-research job streams, reflect its progress in the tab title.
  // The base "<Project> · Chat — Piloti" title comes from route metadata
  // (chat/layout + the project layout template); this override cleanly hands
  // that title back when the job completes or the page unmounts.
  useDeepResearchTitle()

  // Deep link from Overview's "Ask Piloti" actions: /projects/:id/chat?ask=<question>.
  // Seed the store-backed composer prefill (consumed once by InputArea) and then
  // strip the param from the URL so a refresh/back-nav doesn't re-inject it. The
  // guard ref keeps this to a single application per distinct question.
  const askPrefill = searchParams?.get('ask') ?? null
  const consumedAskRef = useRef<string | null>(null)

  // Sidebar "Frag Piloti" entry point: /projects/:id/chat?new=1 always lands on
  // a fresh, empty chat rather than the last thread. Consume the flag once —
  // reset the store to a new-session draft via the SAME mechanism the toolbar's
  // "New chat" uses (startNewSessionDraft) — then strip ?new so a refresh or
  // back-nav doesn't re-trigger it. The guard ref keeps it to a single run.
  const newParam = searchParams?.get('new') ?? null
  const consumedNewRef = useRef(false)

  useEffect(() => {
    if (!newParam || !isAuthenticated || consumedNewRef.current) return
    consumedNewRef.current = true
    startNewSessionDraft()

    if (pathname) {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.delete('new')
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    }
  }, [newParam, isAuthenticated, searchParams, pathname, router, startNewSessionDraft])

  useEffect(() => {
    setProjectId(projectId)
    // Hydrate this project's server-side sessions into the store: the
    // app-wide initial load is org-wide and capped, so a busy org could
    // otherwise miss this project's conversations in the sessions panel.
    void loadServerConversations(projectId)
    return () => setProjectId(null)
  }, [projectId, setProjectId, loadServerConversations])

  useEffect(() => {
    if (!askPrefill || consumedAskRef.current === askPrefill) return
    consumedAskRef.current = askPrefill
    setComposerPrefill(askPrefill)

    // Remove ?ask= (preserving any other params, e.g. ?job=) without adding a
    // history entry.
    if (pathname) {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.delete('ask')
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    }
  }, [askPrefill, searchParams, pathname, router, setComposerPrefill])

  useEffect(() => {
    if (!isAuthenticated || !jobId) return
    // Guard against re-loading the same job across re-renders.
    if (loadedJobRef.current === jobId) return
    loadedJobRef.current = jobId
    void loadResearchPanelTab(jobId, jobTab)
  }, [isAuthenticated, jobId, jobTab, loadResearchPanelTab])

  return (
    <MainLayout
      isAuthenticated={isAuthenticated}
      onSignIn={signIn}
      showSourceBadges={showSourceBadges}
      showConfidenceChip={showConfidenceChip}
      showAnswerFeedback={showAnswerFeedback}
      showResearchInHistory={showResearchInHistory}
      projectCollection={projectCollection}
      projectName={projectName}
      canCollaborate={canCollaborate}
    />
  )
}

/**
 * Client half of the project chat route. The server page computes the two
 * chat feature flags and passes them here; they are prop-drilled to the
 * feature-flagged surfaces (ReportTab badges, AgentResponse confidence chip)
 * via MainLayout.
 */
export const ProjectChatClient = (props: ProjectChatClientProps): ReactNode => {
  return (
    <Suspense fallback={null}>
      <ProjectChatContent {...props} />
    </Suspense>
  )
}

export default ProjectChatClient
