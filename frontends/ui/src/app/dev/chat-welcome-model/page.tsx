'use client'

/**
 * The same empty chat canvas as `/dev/chat-welcome`, in a project that HAS a
 * readable IFC model — the state where the welcome offers to ask the building
 * something, not only the Richtlinien.
 *
 * This is the discovery moment for the whole model feature: chat is where a
 * model is used, and an architect who has just uploaded 150 MB of their own
 * building has no reason to suspect it can be counted, checked and compared
 * unless the canvas says so. Two routes rather than one flag, so the ordinary
 * welcome stays pinned as it is and the difference between them is visible in
 * the screenshots.
 *
 * A module-scope fetch shim (browser + dev only) answers the project's model
 * list. Not linked from anywhere and 404s outside development.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea } from '@/features/layout/components'
import { useChatStore } from '@/features/chat'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

const PROJECT_ID = 'dev-project-with-model'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __chatWelcomeModelShim?: boolean }
  if (!w.__chatWelcomeModelShim) {
    w.__chatWelcomeModelShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/projects\/.+\/bim\/models$/.test(url)) {
        return Response.json({
          models: [
            {
              id: 'dev-bim-1',
              documentId: 'dev-model-1',
              projectId: PROJECT_ID,
              filename: 'Wohnhaus-Grungasse-14_V3.ifc',
              status: 'ready',
              schemaVersion: 'IFC4',
              elementCount: 1842,
              errorMessage: null,
              summary: null,
              updatedAt: '2026-08-04T08:34:00Z',
            },
          ],
        })
      }
      return real(input, init)
    }
  }
}

export default function ChatWelcomeModelPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Seeded after mount so server and first client render agree, exactly as the
  // sibling route does.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    useChatStore.setState({
      projectId: PROJECT_ID,
      currentConversation: {
        id: 'dev-welcome-model-conv',
        userId: 'dev',
        projectId: PROJECT_ID,
        title: 'Dev',
        messages: [],
        createdAt: new Date('2024-01-15'),
        updatedAt: new Date('2024-01-15'),
      },
      hasHydrated: true,
    })
    setReady(true)
  }, [])

  return (
    <AppConfigProvider config={config}>
      <main className="bg-background flex h-dvh flex-col">
        {ready && <ChatArea isAuthenticated />}
      </main>
    </AppConfigProvider>
  )
}
