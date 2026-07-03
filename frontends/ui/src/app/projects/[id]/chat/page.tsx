'use client'

import { type ReactNode, Suspense, useEffect, use } from 'react'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { useChatStore } from '@/features/chat'

interface ProjectChatPageProps {
  params: Promise<{ id: string }>
}

const ProjectChatContent = ({ projectId }: { projectId: string }): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()
  const setProjectId = useChatStore((s) => s.setProjectId)

  useEffect(() => {
    setProjectId(projectId)
    return () => setProjectId(null)
  }, [projectId, setProjectId])

  return (
    <MainLayout
      isAuthenticated={isAuthenticated}
      onSignIn={signIn}
      withShell={false}
    />
  )
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
