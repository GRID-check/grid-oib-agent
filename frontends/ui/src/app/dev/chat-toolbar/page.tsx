'use client'

/**
 * Dev preview for the floating **chat toolbar** — the two pills that ride above
 * the chat plane (`ChatToolbar`), rendered at the real width they get in the app.
 *
 * Why this preview exists: the toolbar is the one surface where four independent
 * features meet in a fixed 768px column — the history door, the thread's
 * identity (project / title), who can reach the thread, and the actions. Each was
 * added on its own and looked fine on its own; together they became a flat list of
 * six equal-weight things that squeezed the breadcrumb until the project name
 * rendered as "Te…". Nothing in the app captured that, because `ChatToolbar` is
 * mounted by `MainLayout`, not by `ChatArea`, so the `/dev/shared-thread` shot
 * does not contain it.
 *
 * What the shots are evidence OF, now that it is not a flat list:
 *   - status and controls are separated by a hairline, and status is never
 *     clickable — the avatar stack used to be a button that looked like
 *     information, the access chip information that looked like a control;
 *   - only New chat stays in the open. Share, rename and the research report are
 *     occasional, so they live in the one "…" menu;
 *   - nothing appears that has nothing to say: no chip on a private thread, no
 *     separator with an empty status group, no menu at all when there is no
 *     action to disclose.
 *
 * The rows are the states whose *combination* is the hard part:
 *   1. **solo private** — the overwhelmingly common thread. Must carry no
 *      collaboration furniture at all: no faces, no access chip.
 *   2. **shared, long names** — the reported crowding case: a long project name,
 *      a long session title and three people, all at once.
 *   3. **project-wide** — the one access state faces cannot express, so the chip
 *      earns its width here and only here.
 *
 * Variants via `?variant=`:
 *   - default    — a thread at rest. This is what most threads look like, which
 *                  is the point of capturing it.
 *   - `running`  — deep research in flight. The one research state that belongs
 *                  in the open row, because it is STATUS: the thread's own
 *                  progress banner scrolls away, and this then is the only
 *                  persistent "still working" signal. Having a REPORT changes
 *                  nothing here — that is a menu entry — which is why the
 *                  captured second state is this one and not that.
 *
 * Each row reproduces the app's geometry: `max-w-3xl` (the message column) inside
 * a `relative` block, because the toolbar positions itself `absolute inset-x-0
 * top-0`.
 *
 * The sharing state comes from a module-scope fetch shim — installed before any
 * effect can fire, browser + development only, idempotent — matching
 * `dev/shared-thread/page.tsx`. `EventSource` is replaced for the same reason it
 * is there: `useSharing` subscribes to the live channel, and without the stub the
 * preview would poll `/api/stream` behind an auth wall for its whole life.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is the
 * product's primary language, so the committed evidence must carry the copy most
 * users actually see.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatToolbar } from '@/features/layout/components/ChatToolbar'
import { useChatStore } from '@/features/chat'
import type { ResourceAccessEntry, ResourceSharingState } from '@/lib/sharing/types'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

/** `useAuth` returns this id when auth is disabled, so it is "me" in the preview. */
const ME = 'default-user'

const person = (userId: string, name: string) => ({
  userId,
  name,
  email: `${name.split(' ')[0]?.toLowerCase()}@buero.at`,
  profilePictureUrl: null,
})

const entry = (
  userId: string,
  name: string,
  role: ResourceAccessEntry['role'],
  reason: ResourceAccessEntry['reason'],
): ResourceAccessEntry => ({ person: person(userId, name), role, reason, grantedBy: null })

const ME_ENTRY = entry(ME, 'Matthias Bigl', 'owner', 'creator')

const sharingState = (
  resourceId: string,
  visibility: ResourceSharingState['visibility'],
  entries: ResourceAccessEntry[],
): ResourceSharingState =>
  ({
    resourceType: 'conversation',
    resourceId,
    visibility,
    allowedVisibilities: ['private', 'project'],
    myRole: 'owner',
    canManage: true,
    canEscalate: false,
    shared: entries.length > 1,
    entries,
  }) as ResourceSharingState

/**
 * One row per state, keyed by the conversation id the shim answers for. The ids
 * are what the toolbar asks the server about, so they are the fixture's key.
 */
const ROWS = [
  {
    id: 'conv-solo',
    caption: 'Privater Einzel-Chat — keine Kollaborations-Möblierung',
    projectName: 'Wohnbau Favoriten',
    sessionTitle: 'Fluchtweglängen OG2',
    state: sharingState('conv-solo', 'private', [ME_ENTRY]),
  },
  {
    id: 'conv-shared',
    caption: 'Geteilt, lange Namen — der gemeldete Gedrängefall',
    projectName: 'Testprojekt Garagenordnung Wien',
    sessionTitle: 'Wiener Garagengesetz — Stellplatzverpflichtung',
    state: sharingState('conv-shared', 'private', [
      ME_ENTRY,
      entry('u-anna', 'Anna Berger', 'collaborator', 'grant'),
      entry('u-tobias', 'Tobias Kern', 'collaborator', 'grant'),
    ]),
  },
  {
    id: 'conv-project',
    caption: 'Projektweit — die Regel, die Gesichter nicht ausdrücken können',
    projectName: 'Wohnbau Nord',
    sessionTitle: 'Brandschutz Stiegenhaus',
    state: sharingState('conv-project', 'project', [
      ME_ENTRY,
      entry('u-anna', 'Anna Berger', 'collaborator', 'visibility-project'),
    ]),
  },
] as const

const STATES_BY_ID = new Map<string, ResourceSharingState>(
  ROWS.map((row) => [row.id, row.state]),
)

// Module scope, so the very first fetch of the hook is already served (idempotent,
// browser + dev only).
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __chatToolbarShim?: boolean }
  if (!w.__chatToolbarShim) {
    w.__chatToolbarShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const match = /^\/api\/sharing\/conversation\/([^/?]+)$/.exec(url)
      const state = match ? STATES_BY_ID.get(decodeURIComponent(match[1])) : undefined
      if (state) return Response.json(state)
      return real(input, init)
    }

    class PreviewEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    ;(window as unknown as { EventSource: unknown }).EventSource = PreviewEventSource
  }
}

export default function ChatToolbarPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Seeded after mount so the server and the first client render agree. The
  // toolbar reads the current conversation only to decide whether renaming is
  // possible, so one seeded id serves every row — and the deep-research fields are
  // store-global, which is exactly why "research is running" is a page variant
  // rather than a fourth row.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const isRunning =
      new URLSearchParams(window.location.search).get('variant') === 'running'
    useChatStore.setState({
      currentUserId: ME,
      hasHydrated: true,
      deepResearchJobId: isRunning ? 'job-preview' : null,
      isDeepResearchStreaming: isRunning,
    })
    setReady(true)
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <main
          className="bg-background flex min-h-dvh flex-col gap-8 p-6"
          data-testid="chat-toolbar-preview"
        >
          {ready &&
            ROWS.map((row) => (
              <section key={row.id} className="flex flex-col gap-2">
                <p className="text-muted-foreground mx-auto w-full max-w-3xl text-xs">
                  {row.caption}
                </p>
                {/* The toolbar positions itself against this block, exactly as it
                    does against the chat plane in MainLayout. */}
                <div className="relative h-20 rounded-lg border border-dashed border-base/60">
                  <ChatToolbar
                    sessionTitle={row.sessionTitle}
                    projectName={row.projectName}
                    conversationId={row.id}
                    currentUserId={ME}
                    isCollaborationEnabled
                    isChatStarted
                  />
                </div>
              </section>
            ))}
        </main>
      </AppConfigProvider>
    </I18nProvider>
  )
}
