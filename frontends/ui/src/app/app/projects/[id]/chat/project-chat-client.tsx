'use client'

import { type ReactNode, Suspense, useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { useChatStore, useLoadJobData, useDeepResearchTitle } from '@/features/chat'
import type { ResearchPanelTab } from '@/features/layout/types'

export interface ProjectChatClientProps {
  projectId: string
  /** Whether report source lines show origin badges (WorkOS `source-origin-badges`). */
  showSourceBadges: boolean
  /** Whether shallow answers show the confidence chip (WorkOS `chat-confidence-chip`). */
  showConfidenceChip: boolean
  /**
   * Whether the sessions panel shows the Deep Research section and per-session
   * research labels (WorkOS `research-in-chat-history`, FB-10).
   */
  showResearchInHistory: boolean
  /** Qdrant collection scoping the Deep Research section's job fetch (FB-10). */
  projectCollection: string | null
}

const ProjectChatContent = ({
  projectId,
  showSourceBadges,
  showConfidenceChip,
  showResearchInHistory,
  projectCollection,
}: ProjectChatClientProps): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()
  const setProjectId = useChatStore((s) => s.setProjectId)
  const loadServerConversations = useChatStore((s) => s.loadServerConversations)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)

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
  // The base "<Project> · Chat — Grid" title comes from route metadata
  // (chat/layout + the project layout template); this override cleanly hands
  // that title back when the job completes or the page unmounts.
  useDeepResearchTitle()

  // Deep link from Overview's "Ask Grid" actions: /projects/:id/chat?ask=<question>.
  // Seed the store-backed composer prefill (consumed once by InputArea) and then
  // strip the param from the URL so a refresh/back-nav doesn't re-inject it. The
  // guard ref keeps this to a single application per distinct question.
  const askPrefill = searchParams?.get('ask') ?? null
  const consumedAskRef = useRef<string | null>(null)

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
      showResearchInHistory={showResearchInHistory}
      projectCollection={projectCollection}
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
