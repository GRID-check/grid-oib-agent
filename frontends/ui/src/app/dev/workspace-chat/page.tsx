'use client'

/**
 * The Büro at rest — dev preview (visual/registry.mjs → `workspace-chat`).
 * Not linked anywhere and 404s outside development.
 *
 * What this capture is evidence of: the two surfaces are the same surface, and
 * the one difference is loud. Beside `/dev/chat-welcome` — the project chat's
 * empty canvas, built from the same `ChatArea` and the same `InputArea` — it
 * shows the greeting unchanged, the `WorkspaceEmptyState` beneath it, and a
 * scope chip that reads "Büro" behind a building glyph instead of a project
 * name behind a dashed ring. If those two shots ever stop differing in exactly
 * those places, the design's one-line rule has been broken
 * (`workspace-chat-ui.md` §1).
 *
 * The org header is deliberately absent: `AppShellChrome` decides the chrome
 * from the pathname and `/dev/app-shell-scopes` is where that pair is
 * photographed. This route is the chat plane.
 *
 * The store's `scope` is what drives all of it, exactly as it does in the
 * product — the empty state reads it, and so does the composer through
 * `MainLayout`, which is why the scope is seeded here rather than the
 * appearance being reproduced.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea, InputArea } from '@/features/layout/components'
import { useComposerMetrics } from '@/features/layout/hooks/use-composer-metrics'
import { motion } from '@/components/motion'
import { useChatStore } from '@/features/chat'
import { I18nProvider } from '@/i18n'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

export default function WorkspaceChatPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Seed after mount so server and first client render agree: an already
  // hydrated, empty workspace conversation, so `ChatArea` renders the welcome
  // canvas rather than its loading skeleton.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const conversation = {
      // `default-user` is the id `useAuth`'s no-backend fallback resolves to;
      // any other id and `setCurrentUser`'s cross-user guard nulls the
      // conversation a tick after it is seeded.
      id: 'dev-workspace-conv',
      userId: 'default-user',
      projectId: null,
      scope: 'workspace' as const,
      title: 'Dev',
      messages: [],
      createdAt: new Date('2026-09-08'),
      updatedAt: new Date('2026-09-08'),
    }
    useChatStore.setState({
      conversations: [conversation],
      currentConversation: conversation,
      projectId: null,
      scope: 'workspace',
      hasHydrated: true,
    })
    setReady(true)
    return () => {
      useChatStore.setState({ scope: 'project' })
    }
  }, [])

  const { composerRef, columnVars, composerStyle, composerMotion } = useComposerMetrics(true)

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <main className="bg-background flex h-dvh flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col" style={columnVars}>
            {ready && <ChatArea isAuthenticated />}
            <motion.div
              ref={composerRef}
              className="absolute inset-x-0 z-10 flex flex-col"
              style={composerStyle}
              {...composerMotion}
            >
              {ready && (
                // The label and the glyph come from the same two props
                // `MainLayout` passes in the product; nothing here is a
                // hand-drawn copy of the chip.
                <InputArea
                  isAuthenticated
                  connectionMode="sse"
                  scope="workspace"
                  projectName="Büro"
                />
              )}
            </motion.div>
          </div>
        </main>
      </AppConfigProvider>
    </I18nProvider>
  )
}
