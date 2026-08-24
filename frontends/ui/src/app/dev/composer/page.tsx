'use client'

/**
 * Composer dev preview: renders the REAL InputArea (chat composer) backend-free —
 * `connectionMode="sse"` disables the WebSocket auto-connect, and a fixture
 * AppConfig satisfies `useAppConfig`. It renders the empty-thread state (source
 * preset chips under the field) at desktop + mobile widths so the composer — the
 * counterpart to the answer card — can be reviewed and screenshotted
 * (visual/registry.mjs → `composer`) in light + dark. Not linked anywhere and
 * 404s outside development.
 *
 * The third block is the READ-ONLY composer a viewer of a shared thread gets. It
 * belongs in the evidence because "read-only" is not one disabled button: the
 * whole control row goes inert (scope, Datengrundlage, Deep Research, attach,
 * send), and the reason is stated under it. That gate was the fix, and until this
 * block existed nothing captured it — the two composers above are private threads
 * with collaboration off, which can never reach it.
 *
 * How the state is produced, honestly: a viewer's role is a SERVER fact, published
 * by the ADR-0033 seam through `publishThreadRole` and read by the composer via
 * `useThreadRole`. The preview writes the same fact into the same seam rather than
 * faking a prop, so it exercises the real predicate. Sharedness is deliberately
 * left unpublished: `useAwaitingState` and the typing broadcast only start on a
 * SHARED thread, and a preview must not open a live channel or a request at a
 * backend that is not there.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { InputArea } from '@/features/layout/components'
import { useChatStore } from '@/features/chat'
import { publishThreadRole } from '@/shared/collaboration/thread-sharing'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

const CONVERSATION_ID = 'dev-composer-conv'
/** What `useAuth` reports when auth is disabled — so this IS the reader here. */
const VIEWER_ID = 'default-user'

export default function ComposerPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  /*
    Seeded after mount so the server and the first client render agree, and
    specifically after the chat store has REHYDRATED — `currentConversation` is a
    persisted key, so zustand's rehydration merges the (empty) localStorage copy
    over whatever is in the store when it lands, and seeding on plain mount raced
    that and lost.

    `userId` is the SIGNED-IN user on purpose. `setCurrentUser` clears
    `currentConversation` whenever its owner is not the current user, and the auth
    provider calls it on mount — so a conversation owned by somebody else is wiped
    a beat after it is seeded. Both defects had the same visible outcome: no
    session id, so no role to look up, so the third block captured a perfectly
    ordinary ENABLED composer while its label claimed it was the read-only one.
    That is exactly the "fixture that cannot exercise the branch" this preview
    exists to rule out, and it is invisible unless somebody looks at the PNG.

    `messages: []` keeps every composer on this page in its empty-thread state,
    which is what the first two blocks are evidence of.
  */
  const hasHydrated = useChatStore((state) => state.hasHydrated)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!hasHydrated) return
    useChatStore.setState({
      currentUserId: VIEWER_ID,
      currentConversation: {
        id: CONVERSATION_ID,
        userId: VIEWER_ID,
        projectId: 'dev',
        title: 'Brandschutz Stiegenhaus Nord',
        messages: [],
        createdAt: new Date('2026-07-29T09:00:00Z'),
        updatedAt: new Date('2026-07-29T09:11:00Z'),
      },
      hasHydrated: true,
    })
    publishThreadRole(CONVERSATION_ID, 'viewer')
    setReady(true)
  }, [hasHydrated])

  return (
    <AppConfigProvider config={config}>
      <main className="min-h-dvh bg-muted/30 px-4 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
          <h1 className="font-mono text-xs text-muted-foreground" data-testid="composer-preview">
            /dev/composer — chat composer (empty-thread state, desktop + mobile)
          </h1>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ desktop</div>
            <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
          </div>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ mobile width (390px)</div>
            <div className="w-[390px] max-w-full">
              <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
            </div>
          </div>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">
              ↓ viewer in a shared thread — read-only
            </div>
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
