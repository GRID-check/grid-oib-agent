'use client'

/**
 * `/dev/stream-chat?history=40&speed=1` — a recorded live answer streamed
 * through the REAL chat store into the real `ChatArea` and composer, with a
 * realistic amount of persisted history beside it.
 *
 * What it is for: measuring what a streamed answer costs the page as a whole.
 * `/dev/stream-replay` renders `AgentResponse` alone, fed by the observer's
 * fold; it cannot see what every delta does to the rest of the app — the
 * persisted store writing itself to localStorage, and every component
 * subscribed to the conversation re-rendering. This one drives the store's
 * own actions (`appendAgentResponseDelta`, `replaceStreamingAgentResponse`,
 * `finalizeAgentResponse`) in the order and at the pace the socket hook calls
 * them, and records per-flush work in `window.__streamChat`:
 *
 *   - `commits`: React commits under the chat, with their actual durations;
 *   - `storageWrites`: localStorage writes of the persisted chat store, which
 *     persists under its own key here so the fixture never replaces the
 *     developer's sessions;
 *   - `longTasks`: main-thread tasks over 50 ms.
 *
 * `history` is the number of persisted conversations seeded beside the open
 * one (ten turns each, the recorded answer as every reply). `shell=1` mounts
 * the whole `MainLayout` (toolbar, sessions panel, chat, composer) instead of
 * the chat and the composer alone. Development only.
 */

import { Profiler, useEffect, useState, type ProfilerOnRenderCallback } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea } from '@/features/layout/components'
import { InputArea } from '@/features/layout/components/InputArea'
import { MainLayout } from '@/features/layout'
import { useChatStore } from '@/features/chat'
import type { ChatMessage, Conversation } from '@/features/chat/types'
import { citationsFromWireList } from '@/features/chat/lib/wire-citation'
import { STREAM_FRAMES } from '../_fixtures/stream-frames'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

interface StreamChatProbe {
  done: boolean
  /** `performance.now()` when the question was sent, and when the first answer frame landed. */
  sentAt: number
  firstFrameAt: number
  commits: { id: string; ms: number }[]
  storageWrites: number
  storageMs: number
  longTasks: number[]
}

declare global {
  interface Window {
    __streamChat?: StreamChatProbe
  }
}

/**
 * Where the store persists while this page is mounted. The fixture history
 * must never reach the real `aiq-chat-store`: that is the developer's own
 * sessions, and a tab closed mid-replay runs no cleanup.
 */
const HARNESS_STORAGE_KEY = 'aiq-chat-store:stream-chat'

const TURN = STREAM_FRAMES.varianten
const ANSWER = TURN.frames[TURN.frames.length - 1]?.content ?? ''
const USER = 'dev-user'

/** `turns` question-and-answer pairs, every answer the recorded one. */
const turnMessages = (prefix: string, turns: number): ChatMessage[] =>
  Array.from({ length: turns }, (_, i): ChatMessage[] => [
    {
      id: `${prefix}-u${i}`,
      role: 'user',
      content: TURN.question,
      timestamp: new Date(2026, 8, 24, 9, i),
      messageType: 'user',
    },
    {
      id: `${prefix}-a${i}`,
      role: 'assistant',
      content: ANSWER,
      timestamp: new Date(2026, 8, 24, 9, i, 30),
      messageType: 'assistant',
    },
  ]).flat()

/** One seeded conversation of `turns` turns. */
const conversation = (id: string, turns: number): Conversation => ({
  id,
  userId: USER,
  projectId: null,
  title: `Verlauf ${id}`,
  messages: turnMessages(id, turns),
  createdAt: new Date(2026, 8, 24, 9),
  updatedAt: new Date(2026, 8, 24, 9, turns),
})

/** Record every commit under a profiled subtree with its actual duration. */
const onRender =
  (probe: StreamChatProbe): ProfilerOnRenderCallback =>
  (id, _phase, actualDuration) => {
    probe.commits.push({ id, ms: Math.round(actualDuration * 10) / 10 })
  }

/** Count and time the persisted store's localStorage writes. */
const instrumentStorage = (probe: StreamChatProbe): (() => void) => {
  const original = Storage.prototype.setItem
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    if (key !== HARNESS_STORAGE_KEY) return original.call(this, key, value)
    const started = performance.now()
    original.call(this, key, value)
    probe.storageWrites += 1
    probe.storageMs += performance.now() - started
  }
  return () => {
    Storage.prototype.setItem = original
  }
}

/** The recorded frames, applied the way `use-websocket-chat` applies them. */
const replay = (
  speed: number,
  later: (run: () => void, ms: number) => void,
  onDone: () => void,
  onFirstFrame: () => void
) => {
  const store = useChatStore.getState
  const t0 = TURN.frames[0]?.t ?? 0
  TURN.frames.forEach((frame, index) =>
    later(
      () => {
        if (index === 0) onFirstFrame()
        const citations = citationsFromWireList(frame.sources)
        if (frame.status === 'complete') {
          store().finalizeAgentResponse(
            frame.content,
            undefined,
            frame.answer_confidence,
            citations
          )
          store().setStreaming(false)
          store().setLoading(false)
        } else if (frame.stream_replace) {
          store().replaceStreamingAgentResponse(frame.content, citations)
        } else if (frame.content) {
          store().appendAgentResponseDelta(
            frame.content,
            undefined,
            frame.answer_confidence,
            citations
          )
        }
        if (index === TURN.frames.length - 1) later(onDone, 1500)
      },
      ((frame.t - t0) * 1000) / speed + 800
    )
  )
}

export default function StreamChatPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const params = useSearchParams()
  const history = Math.max(0, Number(params.get('history') ?? '40') || 0)
  const speed = Number(params.get('speed') ?? '1') || 1
  // How long after mount the question is sent: long enough to profile the send
  // on its own, clear of the page's mount.
  const sendDelay = Number(params.get('delay') ?? '300') || 300
  const shell = params.get('shell') === '1'
  const [probe] = useState<StreamChatProbe>(() => ({
    done: false,
    sentAt: 0,
    firstFrameAt: 0,
    commits: [],
    storageWrites: 0,
    storageMs: 0,
    longTasks: [],
  }))
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Persist to the harness's own key before seeding, and put back both the
    // key and what the store held on the way out.
    const previous = useChatStore.getState()
    const persistedAs = useChatStore.persist.getOptions().name
    useChatStore.persist.setOptions({ name: HARNESS_STORAGE_KEY })
    const current = conversation('open', 6)
    useChatStore.setState({
      currentUserId: USER,
      currentConversation: current,
      conversations: [
        current,
        ...Array.from({ length: history }, (_, i) => conversation(`h${i}`, 10)),
      ],
      hasHydrated: true,
    })
    setReady(true)
    return () => {
      useChatStore.setState(previous)
      useChatStore.persist.setOptions({ name: persistedAs })
      localStorage.removeItem(HARNESS_STORAGE_KEY)
    }
  }, [history])

  useEffect(() => {
    if (!ready) return
    window.__streamChat = probe
    const restoreStorage = instrumentStorage(probe)
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(Math.round(entry.duration))
    })
    observer.observe({ type: 'longtask', buffered: false })
    const timers: number[] = []
    const later = (run: () => void, ms: number) => timers.push(window.setTimeout(run, ms))
    later(() => {
      const store = useChatStore.getState()
      store.addUserMessage(TURN.question)
      store.setLoading(true)
      store.setStreaming(true)
      probe.commits = []
      probe.storageWrites = 0
      probe.storageMs = 0
      probe.longTasks = []
      probe.sentAt = performance.now()
      replay(
        speed,
        later,
        () => (probe.done = true),
        () => (probe.firstFrameAt = performance.now())
      )
    }, sendDelay)
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      observer.disconnect()
      restoreStorage()
    }
  }, [ready, probe, speed, sendDelay])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <div className="bg-background flex h-screen flex-col">
          {ready && shell && (
            <Profiler id="shell" onRender={onRender(probe)}>
              <MainLayout isAuthenticated />
            </Profiler>
          )}
          {ready && !shell && (
            <>
              <Profiler id="chat" onRender={onRender(probe)}>
                <ChatArea isAuthenticated />
              </Profiler>
              <Profiler id="composer" onRender={onRender(probe)}>
                <InputArea isAuthenticated connectionMode="sse" />
              </Profiler>
            </>
          )}
        </div>
      </AppConfigProvider>
    </I18nProvider>
  )
}
