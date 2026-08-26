'use client'

/**
 * Chat welcome-state dev preview: the authenticated empty canvas as a user
 * actually meets it — the REAL `ChatArea` welcome state AND the REAL composer
 * beneath it, rendered backend-free so the surface can be reviewed and
 * screenshotted at desktop + mobile (visual/registry.mjs → `chat-welcome`) in
 * light + dark.
 *
 * The composer is the reason this route exists in this shape. It used to render
 * `ChatArea` alone, which was enough while the canvas was a greeting, a subtitle
 * and a row of example chips — the composer was a separate concern pinned to the
 * bottom of the viewport. It is not a separate concern any more: on an empty
 * thread the composer is LIFTED off the floor (`--composer-lift`, see
 * `useComposerMetrics`) so that it and the greeting read as one group in the
 * middle of the screen. That relationship is the subject under test, and it
 * cannot be photographed one half at a time.
 *
 * The column below reproduces `MainLayout`'s chat column — the same relative
 * flex column, the same absolutely-positioned composer stack — but the geometry
 * itself is NOT reproduced: both call `useComposerMetrics`, which is what keeps
 * this preview from drifting into evidence for a layout the product does not
 * have.
 *
 * `authRequired: false` makes useAuth return the default user without contacting
 * WorkOS; `connectionMode="sse"` keeps the composer off the websocket. Not
 * linked anywhere; 404s outside development.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea, InputArea } from '@/features/layout/components'
import { useComposerMetrics } from '@/features/layout/hooks/use-composer-metrics'
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

  // The thread is empty by construction here, which is the whole point: this is
  // the state that lifts the composer.
  const { composerRef, columnVars, composerStyle } = useComposerMetrics(true)

  return (
    <AppConfigProvider config={config}>
      <main className="bg-background flex h-dvh flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col" style={columnVars}>
          {ready && <ChatArea isAuthenticated />}
          <div
            ref={composerRef}
            className="absolute inset-x-0 z-10 flex flex-col"
            style={composerStyle}
          >
            {/* `canCollaborate` is on so the addressee line renders at all: its
                default state is now silent, and an empty row is exactly the
                evidence this capture is for. */}
            {ready && (
              <InputArea
                isAuthenticated
                connectionMode="sse"
                projectName="Stadthaus Wien 1090"
                canCollaborate
              />
            )}
          </div>
        </div>
      </main>
    </AppConfigProvider>
  )
}
