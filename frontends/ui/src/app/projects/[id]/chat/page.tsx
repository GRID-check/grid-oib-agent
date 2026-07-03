'use client'

import { type ReactNode, Suspense, useEffect, useRef, use } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { useChatStore, useLoadJobData } from '@/features/chat'

interface ProjectChatPageProps {
  params: Promise<{ id: string }>
}

const ProjectChatContent = ({ projectId }: { projectId: string }): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()
  const setProjectId = useChatStore((s) => s.setProjectId)

  // Deep link from the project Research page: /projects/:id/chat?job=<jobId>
  // loads that job's report into the research panel.
  const searchParams = useSearchParams()
  const jobId = searchParams.get('job')
  const { loadResearchPanelTab } = useLoadJobData()
  const loadedJobRef = useRef<string | null>(null)

  useEffect(() => {
    setProjectId(projectId)
    return () => setProjectId(null)
  }, [projectId, setProjectId])

  useEffect(() => {
    if (!isAuthenticated || !jobId) return
    // Guard against re-loading the same job across re-renders.
    if (loadedJobRef.current === jobId) return
    loadedJobRef.current = jobId
    void loadResearchPanelTab(jobId, 'report')
  }, [isAuthenticated, jobId, loadResearchPanelTab])

  return <MainLayout isAuthenticated={isAuthenticated} onSignIn={signIn} />
}

const ProjectChatPage = ({ params }: ProjectChatPageProps): ReactNode => {
  const { id } = use(params)

  return (
    <Suspense fallback={null}>
      <ProjectChatContent projectId={id} />
    </Suspense>
  )
}

export default ProjectChatPage
