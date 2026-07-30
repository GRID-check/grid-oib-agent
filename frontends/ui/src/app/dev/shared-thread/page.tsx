'use client'

/**
 * Dev preview for a SHARED chat thread — the real `ChatArea` driven by the real
 * `useSharedThread` seam (ADR-0033), with a module-scope fetch shim standing in
 * for the BFF so the surface is reproducible with no backend and no database.
 *
 * What it is evidence of, in one screen (spec CC-4, CC-5, CC-13, CC-19):
 *   - three people plus the agent in one thread, each human message attributed
 *     with an avatar + name (the reader's own reading "Sie"/"You");
 *   - **grouping**: Anna's two consecutive messages share one header, the second
 *     aligned under it;
 *   - all four voices distinguishable at a glance WITHOUT messenger left/right:
 *     every human message keeps the same right-hand card bubble (a colleague's and
 *     your own differ only by the avatar + name header), while the agent's answer
 *     is the full-width Ergebnis card and its status output is the Herleitung
 *     spine — so Piloti stays the dominant, central voice in the column;
 *   - the **unread separator** at the point the reader left off;
 *   - the **turn-in-flight banner**: the agent is answering Anna's question, which
 *     is what stops the wait reading as nothing happening.
 *
 * The shim is installed at module scope — before any effect can fire — so the
 * hook's first fetch already sees the fixture. Browser + development only, and
 * idempotent, matching `dev/document-grid/page.tsx`.
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

/** `useAuth` returns this id when auth is disabled, so it is "me" in the preview. */
const ME = 'default-user'
const ANNA = 'user_anna'
const TOBIAS = 'user_tobias'

const CONVERSATION_ID = 'dev-shared-conv'

const PEOPLE = {
  [ME]: { userId: ME, name: 'Default User', email: 'me@example.com', profilePictureUrl: null },
  [ANNA]: { userId: ANNA, name: 'Anna Berger', email: 'anna@example.com', profilePictureUrl: null },
  [TOBIAS]: { userId: TOBIAS, name: 'Tobias Kern', email: 'tobias@example.com', profilePictureUrl: null },
}

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 6, 29, 9, minute, 0)).toISOString()

/** Server message rows, exactly as `GET .../messages` returns them. */
const MESSAGE_ROWS = [
  {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ME,
    content:
      'Wir brauchen für den Wohnbau Nord den Nachweis für den zweiten Fluchtweg. Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?',
    metadata: { messageType: 'user' },
    createdAt: at(2),
  },
  {
    id: 'm2',
    conversationId: CONVERSATION_ID,
    role: 'assistant',
    authorUserId: null,
    content:
      'Ja. Nach OIB-Richtlinie 2 darf die Gehweglänge bis zum Ausgang ins Freie oder in einen anderen Brandabschnitt 40 m nicht überschreiten. Für das nördliche Treppenhaus ergeben die Pläne 34 m, der Nachweis ist damit erbracht.',
    metadata: { messageType: 'agent_response', citations: undefined },
    createdAt: at(3),
  },
  {
    id: 'm3',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ANNA,
    content: 'Danke – ich hänge den Fluchtwegplan gleich an, damit wir dieselbe Fassung prüfen.',
    metadata: { messageType: 'user' },
    createdAt: at(8),
  },
  {
    // Anna again: this one groups under the header above it.
    id: 'm4',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: ANNA,
    content: 'Achtung: im EG ist der Durchgang zum Innenhof laut Bestandsplan verschlossen.',
    metadata: { messageType: 'user' },
    createdAt: at(9),
  },
  {
    id: 'm5',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: TOBIAS,
    content:
      'Dann zählt der Innenhof nicht als zweiter Rettungsweg. @Piloti wie wirkt sich das auf den Nachweis aus?',
    // Structured mentions ride in the metadata and are rendered as chips; the
    // addressee ruling next to them is the SERVER's, stored at persist time (MN-2).
    metadata: {
      messageType: 'user',
      mentions: [{ targetId: 'agent:piloti', display: 'Piloti' }],
      addressees: { agent: true, users: [] },
    },
    createdAt: at(11),
  },
]

const SHARING_STATE = {
  resourceType: 'conversation',
  resourceId: CONVERSATION_ID,
  visibility: 'project',
  allowedVisibilities: ['private', 'project'],
  myRole: 'collaborator',
  canManage: false,
  canEscalate: false,
  shared: true,
  entries: [
    { person: PEOPLE[ANNA], role: 'owner', reason: 'creator', grantedBy: null },
    { person: PEOPLE[ME], role: 'collaborator', reason: 'grant', grantedBy: ANNA },
    { person: PEOPLE[TOBIAS], role: 'collaborator', reason: 'visibility-project', grantedBy: null },
  ],
}

// Module scope, so the very first fetch of the hook is already served (idempotent,
// browser + dev only).
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __sharedThreadShim?: boolean }
  if (!w.__sharedThreadShim) {
    w.__sharedThreadShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (url === `/api/conversations/${CONVERSATION_ID}`) {
        return Response.json({
          id: CONVERSATION_ID,
          title: 'Brandschutz Stiegenhaus Nord',
          createdAt: at(0),
          updatedAt: at(11),
          shared: true,
          myRole: 'collaborator',
          visibility: 'project',
          // The reader last read up to their own answer, so the separator lands
          // above Anna's first message.
          myReadState: { lastReadAt: at(4), lastReadMessageId: 'm2' },
        })
      }
      if (url === `/api/conversations/${CONVERSATION_ID}/messages`) {
        return Response.json(MESSAGE_ROWS)
      }
      if (url === `/api/sharing/conversation/${CONVERSATION_ID}`) {
        return Response.json(SHARING_STATE)
      }
      if (url === `/api/conversations/${CONVERSATION_ID}/read`) {
        return Response.json({ ok: true })
      }
      return real(input, init)
    }

    // The turn-in-flight banner is driven by a live `conversation.turn` event, so
    // the preview stands up a one-frame EventSource rather than faking the
    // component's state: the screenshot then exercises the real path
    // (event-hub → useLiveEvents → useSharedThread → banner). Replacing the
    // constructor also stops the real `/api/stream` route being polled behind an
    // auth wall for the life of the preview.
    class PreviewEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        setTimeout(() => {
          this.onopen?.()
          this.onmessage?.({
            data: JSON.stringify({
              id: 'preview-1',
              at: at(11),
              event: {
                kind: 'conversation.turn',
                conversationId: CONVERSATION_ID,
                phase: 'started',
                actorUserId: TOBIAS,
              },
            }),
          })
        }, 40)
      }
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    ;(window as unknown as { EventSource: unknown }).EventSource = PreviewEventSource
  }
}

export default function SharedThreadPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Seeded after mount so the server and the first client render agree. The store
  // starts EMPTY on purpose: the whole point of ADR-0033 is that a shared thread's
  // history comes from the server, so the preview proves the load path rather than
  // dressing a local fixture.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    useChatStore.setState({
      currentUserId: ME,
      currentConversation: {
        id: CONVERSATION_ID,
        userId: ANNA,
        projectId: 'dev',
        title: 'Brandschutz Stiegenhaus Nord',
        messages: [],
        createdAt: new Date(at(0)),
        updatedAt: new Date(at(11)),
      },
      conversations: [
        {
          id: CONVERSATION_ID,
          userId: ANNA,
          projectId: 'dev',
          title: 'Brandschutz Stiegenhaus Nord',
          messages: [],
          createdAt: new Date(at(0)),
          updatedAt: new Date(at(11)),
        },
      ],
      hasHydrated: true,
    })
    setReady(true)
  }, [])

  return (
    <AppConfigProvider config={config}>
      <main className="bg-background flex h-dvh flex-col" data-testid="shared-thread-preview">
        {ready && <ChatArea isAuthenticated canCollaborate />}
      </main>
    </AppConfigProvider>
  )
}
