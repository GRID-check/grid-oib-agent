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
 *     persists under its own keys here (`aiq-chat-store:stream-chat:*`) so
 *     the fixture never replaces the developer's sessions;
 *   - `longTasks`: main-thread tasks over 50 ms.
 *
 * `history` is the number of persisted conversations seeded beside the open
 * one (ten turns each, the recorded answer as every reply); `extras=1` gives
 * every seeded answer the sources, cards and masthead the recorded one
 * settled with, the weight real answers carry into storage. `shell=1` mounts
 * the whole `MainLayout` (toolbar, sessions panel, chat, composer) instead of
 * the chat and the composer alone. `fixture` picks the recorded answer
 * (`varianten`, the default, or `oib2`), and `repeat=N` streams its prose N
 * times over, as one answer N times as long: what a reveal step costs must
 * not grow with the length of the answer. `steps=N` gives the turn N
 * Herleitung steps when the question is sent, so the Herleitung is open while
 * the answer streams and its collapse can be watched. The recorded cards are
 * replayed on their live `cards` frame and the terminal, so a card's arrival
 * into its `[[card:N]]` place can be watched too; `cards=0` replays the prose
 * alone, as this page did before 2026-09-27. Each commit carries
 * React's `start` and commit (`at`) time, `completeAt` is when the terminal
 * frame landed, and `settledAt` when the answer had finished revealing it and
 * settled (`answer-reveal-store.ts`). Development only.
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
import { useAnswerRevealStore } from '@/features/chat/stores/answer-reveal-store'
import type { ChatMessage, Conversation } from '@/features/chat/types'
import { citationsFromWireList } from '@/features/chat/lib/wire-citation'
import { validateGridCards } from '@/shared/cards/schemas'
import { sanitizeAnswerMeta } from '@/lib/conversations/message-answer-meta'
import { STREAM_FRAMES, type RecordedFrame, type RecordedTurn } from '../_fixtures/stream-frames'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

interface StreamChatProbe {
  done: boolean
  /** `performance.now()` when the question was sent, and when the first answer frame landed. */
  sentAt: number
  firstFrameAt: number
  completeAt: number
  settledAt: number
  commits: { id: string; ms: number; start: number; at: number }[]
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
/** The seeded history's reply, whatever the streamed fixture. */
const TERMINAL = TURN.frames[TURN.frames.length - 1]
const ANSWER = TERMINAL?.content ?? ''
/**
 * What the recorded answer settled with besides its text: its sources, its
 * cards and its masthead. A real answer carries them into storage, and they
 * are most of its weight: forty conversations of bare text are 1.4 M
 * characters, with these about 5 M, past the quota that used to wipe the
 * whole history (`extras=1`).
 */
const ANSWER_EXTRAS: Partial<ChatMessage> = {
  citations: citationsFromWireList(TERMINAL?.sources),
  cards: validateGridCards(TERMINAL?.cards ?? []),
  answerMeta: sanitizeAnswerMeta(TERMINAL?.answer_meta) ?? undefined,
  answerConfidence: TERMINAL?.answer_confidence,
}
// The id `useAuth`'s no-backend fallback resolves to (`adapters/auth/use-auth.ts`).
// Any other id is reset by `setCurrentUser` on mount, and the cross-user guard
// then empties the open thread and the sidebar: with 'dev-user' this harness
// measured an empty thread for every `history=` it was given (React
// performance audit, 2026-09; gotchas.md).
const USER = 'default-user'

/** `turns` question-and-answer pairs, every answer the recorded one. */
const turnMessages = (prefix: string, turns: number, extras: boolean): ChatMessage[] =>
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
      ...(extras ? ANSWER_EXTRAS : {}),
    },
  ]).flat()

/**
 * One seeded conversation of `turns` turns, updated `rank` minutes before
 * the newest: the storage evicts the least recently updated first, so the
 * seeded history must have an order.
 */
const conversation = (id: string, turns: number, extras: boolean, rank: number): Conversation => ({
  id,
  userId: USER,
  projectId: null,
  title: `Verlauf ${id}`,
  messages: turnMessages(id, turns, extras),
  createdAt: new Date(2026, 8, 24, 9),
  updatedAt: new Date(2026, 8, 24, 10, 0 - rank),
})

/** Record every commit under a profiled subtree with its actual duration. */
const onRender =
  (probe: StreamChatProbe): ProfilerOnRenderCallback =>
  (id, _phase, actualDuration, _base, startTime, commitTime) => {
    probe.commits.push({ id, ms: Math.round(actualDuration * 10) / 10, start: startTime, at: commitTime })
  }

/** The prose, and the `## Quellen` section after it (empty when there is none). */
const proseAndSources = (text: string): [string, string] => {
  const at = text.search(/\n#{1,3} Quellen\b/)
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at)]
}

/** `text` with its prose written `times` times over and its sources once, at the end. */
const repeatedText = (text: string, times: number): string => {
  const [prose, sources] = proseAndSources(text)
  return Array.from({ length: times }, () => prose.trimEnd()).join('\n\n') + sources
}

/**
 * A synthetic answer `times` as long as the recorded one: its prose deltas
 * streamed `times` times over at their recorded pace, then its snapshot and
 * terminal with the prose repeated as often.
 */
const lengthened = (turn: RecordedTurn, times: number): RecordedTurn => {
  const isDelta = (frame: RecordedFrame) =>
    frame.status !== 'complete' && !frame.stream_replace && frame.content !== ''
  const deltas = turn.frames.filter(isDelta)
  const firstDelta = deltas[0]
  const lastDelta = deltas[deltas.length - 1]
  if (times <= 1 || !firstDelta || !lastDelta) return turn
  const last = turn.frames.indexOf(lastDelta)
  const span = lastDelta.t - firstDelta.t + 0.1
  const passes = Array.from({ length: times - 1 }, (_, pass) =>
    deltas.map((frame, index) => ({
      ...frame,
      t: frame.t + span * (pass + 1),
      content: index === 0 ? `\n\n${frame.content}` : frame.content,
    }))
  ).flat()
  const after = turn.frames.slice(last + 1).map((frame) => ({
    ...frame,
    t: frame.t + span * (times - 1),
    content: frame.content ? repeatedText(frame.content, times) : frame.content,
  }))
  return { ...turn, frames: [...turn.frames.slice(0, last + 1), ...passes, ...after] }
}

/** Count and time the persisted store's localStorage writes, one per key written. */
const instrumentStorage = (probe: StreamChatProbe): (() => void) => {
  const original = Storage.prototype.setItem
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    if (!key.startsWith(HARNESS_STORAGE_KEY)) return original.call(this, key, value)
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
  turn: RecordedTurn,
  speed: number,
  withCards: boolean,
  later: (run: () => void, ms: number) => void,
  onDone: () => void,
  onFirstFrame: () => void,
  onComplete: () => void
) => {
  const store = useChatStore.getState
  const t0 = turn.frames[0]?.t ?? 0
  turn.frames.forEach((frame, index) =>
    later(
      () => {
        if (index === 0) onFirstFrame()
        const citations = citationsFromWireList(frame.sources)
        // Validated per frame, as the socket hook does: a new object every
        // time, which the store keeps as the one it has while it is equal.
        const cards = withCards && frame.cards ? validateGridCards(frame.cards) : undefined
        if (frame.status === 'complete') {
          // Recorded first: an answer that settles at once (a rewrite, a
          // hidden page) clears its reveal inside these updates, and the
          // settle probe only counts a clear that follows `completeAt`.
          onComplete()
          store().finalizeAgentResponse(frame.content, cards, frame.answer_confidence, citations)
          store().settleTurn()
          store().setLoading(false)
        } else if (frame.stream_replace) {
          store().replaceStreamingAgentResponse(frame.content, citations)
        } else if (frame.content || cards?.length) {
          // A live `cards` frame has no text: the card arrives into the place
          // its `[[card:N]]` marker has been holding (`CardSlotArrival.tsx`).
          store().appendAgentResponseDelta(frame.content, cards, frame.answer_confidence, citations)
        }
        if (index === turn.frames.length - 1) later(onDone, 1500)
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
  const fixture = params.get('fixture') === 'oib2' ? 'oib2' : 'varianten'
  const repeat = Math.max(1, Math.floor(Number(params.get('repeat') ?? '1')) || 1)
  const steps = Math.max(0, Math.floor(Number(params.get('steps') ?? '0')) || 0)
  // The recorded cards, on their live frame and the terminal; `cards=0` replays the prose alone.
  const withCards = params.get('cards') !== '0'
  const [turn] = useState(() => lengthened(STREAM_FRAMES[fixture], repeat))
  const extras = params.get('extras') === '1'
  const [probe] = useState<StreamChatProbe>(() => ({
    done: false,
    sentAt: 0,
    firstFrameAt: 0,
    completeAt: 0,
    settledAt: 0,
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
    const current = conversation('open', 6, extras, 0)
    useChatStore.setState({
      currentUserId: USER,
      currentConversation: current,
      conversations: [
        current,
        ...Array.from({ length: history }, (_, i) => conversation(`h${i}`, 10, extras, i + 1)),
      ],
      hasHydrated: true,
    })
    setReady(true)
    return () => {
      useChatStore.setState(previous)
      useChatStore.persist.clearStorage()
      useChatStore.persist.setOptions({ name: persistedAs })
    }
  }, [history, extras])

  useEffect(() => {
    if (!ready) return
    window.__streamChat = probe
    const restoreStorage = instrumentStorage(probe)
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(Math.round(entry.duration))
    })
    observer.observe({ type: 'longtask', buffered: false })
    const unsubscribeReveal = useAnswerRevealStore.subscribe((state, prev) => {
      if (probe.completeAt > 0 && prev.revealingId !== null && state.revealingId === null) {
        probe.settledAt = performance.now()
      }
    })
    const timers: number[] = []
    const later = (run: () => void, ms: number) => timers.push(window.setTimeout(run, ms))
    later(() => {
      const store = useChatStore.getState()
      store.addUserMessage(turn.question)
      store.setLoading(true)
      store.setStreaming(true)
      for (let i = 0; i < steps; i++) {
        store.addThinkingStep({
          category: 'tools',
          functionName: 'knowledge_retrieval',
          displayName: `Recherche ${i + 1}`,
          content: '',
          isComplete: true,
          isTopLevel: true,
        })
      }
      probe.commits = []
      probe.storageWrites = 0
      probe.storageMs = 0
      probe.longTasks = []
      probe.sentAt = performance.now()
      replay(
        turn,
        speed,
        withCards,
        later,
        () => (probe.done = true),
        () => (probe.firstFrameAt = performance.now()),
        () => (probe.completeAt = performance.now())
      )
    }, sendDelay)
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      observer.disconnect()
      unsubscribeReveal()
      restoreStorage()
    }
  }, [ready, probe, speed, sendDelay, turn, steps, withCards])

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
