'use client'

/**
 * Chat welcome-state dev preview: the REAL ChatArea in its authenticated
 * empty-thread state (WelcomeState) — the time-of-day greeting, the one-line
 * subtitle telling a first-timer that answers cite their sources, and the
 * example-question chips — rendered backend-free so the empty canvas can be
 * reviewed and screenshotted at desktop + mobile (visual/registry.mjs →
 * `chat-welcome`) in light + dark.
 *
 * Seeds an empty, hydrated conversation into the chat store so ChatArea shows
 * the welcome state (not the hydration skeleton). `authRequired: false` makes
 * useAuth return the default user without contacting WorkOS. Not linked
 * anywhere; 404s outside development.
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

export default function ChatWelcomePreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Seed after mount (server + first client render agree → no hydration
  // mismatch): an empty, already-hydrated conversation so ChatArea renders the
  // WelcomeState rather than the loading skeleton.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    useChatStore.setState({
      currentConversation: {
        id: 'dev-welcome-conv',
        userId: 'dev',
        projectId: 'dev',
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
