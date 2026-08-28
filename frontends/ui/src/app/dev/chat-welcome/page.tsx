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
 * flex column, the same absolutely-positioned composer stack, the same bottom
 * fade scrim — but the geometry itself is NOT reproduced: both call
 * `useComposerMetrics`, which is what keeps this preview from drifting into
 * evidence for a layout the product does not have.
 *
 * `?variant=populated` swaps the empty canvas for a short finished thread —
 * an answer with sources, a skills disclosure and a follow-ups rail sitting
 * right above the composer — because the empty state cannot show whether the
 * transcript and the floating composer read as one collided block or as a
 * transcript with an input glass floating over it (the fade scrim + the
 * composer's own narrower, blurred surface). `useComposerMetrics(false)` here:
 * a populated thread never lifts the composer off the floor.
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
import type { ChatMessage } from '@/features/chat'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

/**
 * A short finished thread: the question, then an answer long enough to reach
 * the composer's fade scrim, with a source, a used skill and a follow-ups
 * rail — the exact stack (sources row → skills disclosure → composer) the
 * overlap fix targets.
 */
const populatedMessages: ChatMessage[] = [
  {
    id: 'dev-populated-q',
    role: 'user',
    messageType: 'user',
    content: 'Wie viele Rettungswege brauche ich für ein Bürogebäude der Gebäudeklasse 4 in Wien?',
    timestamp: new Date('2024-01-15T14:30:00'),
  },
  {
    id: 'dev-populated-a',
    role: 'assistant',
    messageType: 'agent_response',
    timestamp: new Date('2024-01-15T14:30:05'),
    content: `Für ein Bürogebäude der **Gebäudeklasse 4** sind in der Regel **zwei voneinander unabhängige Fluchtwege** erforderlich.

- **Erster Fluchtweg** — ein baulicher Rettungsweg über ein Sicherheitstreppenhaus.
- **Zweiter Fluchtweg** — ein zweiter baulicher Weg oder eine über die Feuerwehr anleiterbare Stelle.

Die maximale Fluchtweglänge bis zum sicheren Bereich beträgt **40 m** [1]; § 108 BO Wien verlangt zusätzlich den zweiten Weg [2].`,
    citations: [
      {
        id: 'src-1',
        content: 'OIB-Richtlinie 2 · Brandschutz',
        timestamp: new Date('2024-01-15'),
        origin: 'kb',
        isCited: true,
        number: 1,
      },
      {
        id: 'src-2',
        content: 'Bauordnung für Wien § 108',
        timestamp: new Date('2024-01-15'),
        origin: 'ris',
        isCited: true,
        number: 2,
      },
    ],
    answerConfidence: 'high',
    skillsActivated: ['piloti-voice', 'fluchtweg-bemessung'],
    stages: {
      followUps: {
        items: [
          { question: 'Welche Gebäudeklasse ergibt sich für mein Projekt?' },
          { question: 'Was ändert sich beim Sprung von GK 4 auf GK 5?' },
        ],
      },
    },
  },
]

export default function ChatWelcomePreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read the requested variant after mount (not during render), same reason
  // `/dev/chat-turn` does: the fixture must never be captured under the
  // default's name because the server render ran before the query string
  // was available.
  const [variant, setVariant] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    setVariant(new URLSearchParams(window.location.search).get('variant'))
  }, [])
  const isPopulated = variant === 'populated'

  // Seed after mount (server + first client render agree → no hydration
  // mismatch): an already-hydrated conversation so ChatArea renders the
  // WelcomeState (empty) or the populated fixture rather than the loading
  // skeleton.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (variant === undefined) return
    // userId MUST be the id `useAuth`'s no-backend fallback resolves to
    // (`'default-user'`, `adapters/auth/use-auth.ts`), not an arbitrary
    // fixture id. `useWebSocketChat` (mounted inside the real `InputArea`
    // below) calls `setCurrentUser(authUserId)` on mount, and that action's
    // cross-user guard (`sessions-store.ts` `setCurrentUser`) clears
    // `currentConversation` whenever its `userId` differs from the id being
    // signed in — exactly what a stray 'dev' id here silently tripped: the
    // conversation seeded fine, then was nulled a tick later, invisible on
    // the empty fixture (null before, null after) and only exposed once a
    // populated one made "then it went back to null" visible.
    const seededConversation = {
      id: 'dev-welcome-conv',
      userId: 'default-user',
      projectId: 'dev',
      title: 'Dev',
      messages: isPopulated ? populatedMessages : [],
      createdAt: new Date('2024-01-15'),
      updatedAt: new Date('2024-01-15'),
    }
    useChatStore.setState({
      conversations: [seededConversation],
      currentConversation: seededConversation,
      hasHydrated: true,
    })
    setReady(true)
  }, [variant, isPopulated])

  // The thread is empty only in the default fixture, which is the whole
  // point: that is the state that lifts the composer. A populated thread
  // never does.
  const { composerRef, columnVars, composerStyle } = useComposerMetrics(!isPopulated)

  if (variant === undefined) return null

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
