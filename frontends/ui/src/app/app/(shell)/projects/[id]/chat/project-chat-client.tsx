'use client'

import { type ReactNode, Suspense, useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { useChatStore, useLoadJobData, useDeepResearchTitle } from '@/features/chat'
import { conversationMatchesProject } from '@/features/chat/lib/project-scope'
import type { ResearchPanelTab } from '@/features/layout/types'
import { newChatDropsFilePreview } from '@/features/documents/lib/ask-arrival'
import { fileItemFromStatus } from '@/features/documents/lib/document-question'
import { isUuid } from '@/lib/ids'
import { useCitationPeek } from '@/features/documents/hooks/use-citation-peek'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'

export interface ProjectChatClientProps {
  projectId: string
  /**
   * Whether the collaboration surfaces are available (ADR-0032…0035).
   * Dark-launched, so the server page resolves it and it is prop-drilled here
   * rather than defaulting on.
   */
  canCollaborate?: boolean
  /** Whether the reader holds `project:chat` on this project. */
  canChatInProject?: boolean
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
  canChatInProject = true,
}: ProjectChatClientProps): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()
  const setProjectId = useChatStore((s) => s.setProjectId)
  const loadServerConversations = useChatStore((s) => s.loadServerConversations)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const startNewSessionDraft = useChatStore((s) => s.startNewSessionDraft)
  const selectConversation = useChatStore((s) => s.selectConversation)
  // Retry triggers, not values: a deep-linked id this browser has never seen
  // only becomes resolvable once the server list lands (or identity arrives).
  const sessionConversationCount = useChatStore((s) => s.conversations.length)
  const sessionServerLoaded = useChatStore((s) => s.serverConversationsLoaded)
  const sessionUserId = useChatStore((s) => s.currentUserId)

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
  const docPrefill = searchParams?.get('doc') ?? null
  const filePrefill = searchParams?.get('file') ?? null
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
    // Sidebar Frag Piloti (`?new=1` alone) is an empty draft — drop the
    // previous peek (#441). `?new=1&doc=` is "new chat ABOUT this file"
    // from Piloti dazu fragen; closing the peek there leaves no visual
    // of the subject.
    if (newChatDropsFilePreview(searchParams?.get('doc'))) {
      useFilePreviewStore.getState().close()
    }

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

  // `?session=` deep link — including the job-output threads the sessions
  // panel hides. `useSessionUrl` (mounted inside MainLayout below) resolves a
  // session only against the personal list, so a task row's "continue in
  // chat" link into a job-produced conversation reads as a stale id there,
  // gets stripped from the URL, and lands on whatever thread was last active.
  // This hydrates the same param against every conversation in THIS project
  // first: the lookup deliberately includes job conversations
  // (`lib/project-scope.ts` promises `?session=<id>` selects one), while the
  // switch itself stays with `selectConversation`, whose ownership and
  // project-context guards remain authoritative (UX-8).
  const sessionParam = searchParams?.get('session') ?? null
  const sessionHydratedRef = useRef<string | null>(null)

  useEffect(() => {
    // A fresh draft wins over a thread: `?new=1` always lands on an empty
    // chat, and hydrating a session underneath it would undo that.
    if (!isAuthenticated || !sessionParam || newParam) return
    if (sessionHydratedRef.current === sessionParam) return
    // Identity first, like `useSessionUrl`: the selection guard stamps rows
    // to the fetcher, so attempting before the user is known can only refuse.
    if (!sessionUserId) return
    const state = useChatStore.getState()
    if (state.currentConversation?.id === sessionParam) {
      sessionHydratedRef.current = sessionParam
      return
    }
    const target = state.conversations.find((c) => c.id === sessionParam)
    if (!target) {
      // Not stale, just not fetched yet: a deep-linked id this browser never
      // saw only resolves once the server list lands. Giving up here would
      // strand every task link on its first open.
      if (!sessionServerLoaded) return
      sessionHydratedRef.current = sessionParam
      return
    }
    // Never activate another project's session under this socket, and never
    // another person's: both stay `selectConversation`'s call, which refuses
    // them the same way. Unknown ids are left for `useSessionUrl`'s stale
    // handling rather than landing on the wrong thread here.
    if (!conversationMatchesProject(target, projectId) || target.userId !== sessionUserId) {
      sessionHydratedRef.current = sessionParam
      return
    }
    selectConversation(sessionParam)
    sessionHydratedRef.current = sessionParam
  }, [
    isAuthenticated,
    sessionParam,
    newParam,
    projectId,
    sessionConversationCount,
    sessionServerLoaded,
    sessionUserId,
    selectConversation,
  ])

  useEffect(() => {
    // Files, IFC walls and applicable standards all land here: one Ask Piloti
    // pipe (`setComposerPrefill`). `doc` is the optional subject of that ask,
    // not a second chat.
    const token = `${askPrefill ?? ''}|${docPrefill ?? ''}|${filePrefill ?? ''}`
    if ((!askPrefill && !docPrefill) || consumedAskRef.current === token) return
    consumedAskRef.current = token
    setComposerPrefill(
      askPrefill ?? '',
      undefined,
      docPrefill && isUuid(docPrefill)
        ? {
            resourceType: 'document',
            resourceId: docPrefill,
            filename: filePrefill,
            title: filePrefill,
            shelf: 'project',
          }
        : undefined
    )

    if (pathname) {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.delete('ask')
      params.delete('doc')
      params.delete('file')
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    }
  }, [askPrefill, docPrefill, filePrefill, searchParams, pathname, router, setComposerPrefill])

  const composerSubject = useChatStore((s) => s.composerSubject)
  const subjectId = composerSubject?.resourceId ?? docPrefill

  // Citations are the signal to show a project/Büro file — do not wait for
  // the agent to call surface_documents. Mounted once on the chat client.
  useCitationPeek({ projectId, projectName, canCollaborate })

  useEffect(() => {
    // `?doc=` is a documents.id. A filename here used to hit
    // GET /api/documents/<filename>/status and 500 (#572).
    if (!subjectId || !isUuid(subjectId)) return
    const preview = useFilePreviewStore.getState()
    if (preview.file?.id === subjectId) {
      preview.peek()
      return
    }
    let cancelled = false
    void fetch(`/api/documents/${encodeURIComponent(subjectId)}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body?.id) return
        const item = fileItemFromStatus(body)
        useFilePreviewStore.getState().open(item, 'peek', {
          projectId,
          projectName: projectName ?? undefined,
          scope: 'files',
          canCollaborate,
        })
        const subject = useChatStore.getState().composerSubject
        if (subject?.resourceId === item.id && !subject.filename) {
          useChatStore.getState().setComposerSubject({
            ...subject,
            title: subject.title || item.filename,
            filename: item.filename,
            shelf: subject.shelf ?? 'project',
          })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [subjectId, projectId, projectName, canCollaborate])

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
      canChatInProject={canChatInProject}
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
