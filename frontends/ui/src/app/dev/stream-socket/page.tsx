'use client'

/**
 * `/dev/stream-socket?mode=heavy&speed=1` — one chat turn through the REAL
 * socket client, hook, store and components, with a scripted NAT server
 * behind a stubbed `window.WebSocket`.
 *
 * Why it exists: `/dev/stream-chat` and `/dev/stream-replay` call the store's
 * actions directly and give every step an empty payload, so they never see
 * what the socket carries before the answer. A production turn pinned the main
 * thread for 47 s on exactly that: hundreds of 17 to 31 KB step frames (NAT's
 * stock step adaptor sends one per LLM token chunk, each with the whole prompt
 * and the knowledge-search output in it). Here those frames go through
 * `NATWebSocketClient` → `useWebSocketChat` → the chat store → `ChatArea`,
 * the path the product takes.
 *
 * `mode=heavy` is that trace's wire; `mode=light` is the same turn as a
 * compacted step adaptor would send it (`nat-script.ts`). The answer is the
 * recorded `oib2` turn, `speed` times its recorded pace. The question is sent
 * by the composer itself once the socket is open (`autosend=0` leaves that to
 * you). Everything measured lands in `window.__streamSocket`;
 * `scripts/measure-stream-socket.mjs` drives it and prints the summary.
 *
 * Development only. The numbers are `next dev` numbers: compare heavy with
 * light, and before with after, in the same mode, never with production.
 */

import { useEffect, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea } from '@/features/layout/components'
import { InputArea } from '@/features/layout/components/InputArea'
import { useChatStore } from '@/features/chat'
import { useAnswerRevealStore } from '@/features/chat/stores/answer-reveal-store'
import type { Conversation } from '@/features/chat/types'
import { buildNatScript, type FrameKind, type ScriptMode } from './nat-script'
import { installFakeNatServer } from './fake-nat-server'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

// `useWebSocketChat` resets any other user id on mount, and the cross-user
// guard then empties the thread (gotchas.md).
const USER = 'default-user'
const HARNESS_STORAGE_KEY = 'aiq-chat-store:stream-socket'
const CONVERSATION_ID = 'stream-socket'

/**
 * The first card on screen. An unplaced `legal_basis` (the `oib2` answer's
 * card) draws as `EvidenceBlock`, a section labelled with the card name; A2UI
 * and grid cards mark themselves.
 */
const CARD_SELECTOR = 'section[aria-label="Rechtsgrundlage"], [data-a2ui-root], [data-a2ui-surface]'

interface StreamSocketProbe {
  mode: ScriptMode
  done: boolean
  connected: boolean
  /** `performance.now()` when the user message reached the fake server. */
  sentAt: number
  firstStepAt: number
  firstDeltaAt: number
  firstCardAt: number
  /** When the client finished handling the terminal frame. */
  completeAt: number
  /** When the answer had revealed its text and settled (`answer-reveal-store.ts`). */
  settledAt: number
  framesScripted: number
  stepBytes: number
  framesHandled: number
  heartbeats: number
  /** When the worker sent the last frame, and when the client finished handling it. */
  lastSentAt: number
  lastHandledAt: number
  /** Worst gap between a frame being sent and the client finishing it. */
  maxFrameLagMs: number
  longTasks: { start: number; ms: number }[]
  /** Summed rAF gaps beyond one 60 Hz frame: a main-thread busy estimate that sees short tasks too. */
  rafBusyMs: number
  layoutShift: number
}

declare global {
  interface Window {
    __streamSocket?: StreamSocketProbe
  }
}

const openConversation = (): Conversation => ({
  id: CONVERSATION_ID,
  userId: USER,
  projectId: null,
  title: 'Stream socket',
  messages: [],
  createdAt: new Date(2026, 8, 24, 9),
  updatedAt: new Date(2026, 8, 24, 9),
})

/** Routes the page would otherwise send to a backend that is not there: answered at once, empty. */
const stubApiFetch = (): (() => void) => {
  const realFetch = window.fetch
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, window.location.href)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = method === 'GET' ? '[]' : '{}'
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  return () => {
    window.fetch = realFetch
  }
}

/** Long tasks, layout shift and rAF gaps from the moment the question is sent. */
const observe = (probe: StreamSocketProbe): (() => void) => {
  const longTasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (probe.sentAt > 0 && !probe.done) probe.longTasks.push({ start: Math.round(entry.startTime), ms: Math.round(entry.duration) })
    }
  })
  longTasks.observe({ type: 'longtask', buffered: false })
  const shifts = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (probe.sentAt > 0 && !probe.done && !entry.hadRecentInput) probe.layoutShift += entry.value
    }
  })
  shifts.observe({ type: 'layout-shift', buffered: false })
  let raf = 0
  let last = performance.now()
  const frame = (now: number) => {
    if (probe.sentAt > 0 && !probe.done) probe.rafBusyMs += Math.max(0, now - last - 1000 / 60)
    last = now
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  const cards = new MutationObserver(() => {
    if (probe.sentAt === 0 || probe.firstCardAt > 0) return
    if (document.querySelector(CARD_SELECTOR)) probe.firstCardAt = performance.now()
  })
  cards.observe(document.body, { childList: true, subtree: true })
  const unsubscribeReveal = useAnswerRevealStore.subscribe((state, prev) => {
    if (probe.completeAt > 0 && prev.revealingId !== null && state.revealingId === null) {
      probe.settledAt = performance.now()
    }
  })
  return () => {
    longTasks.disconnect()
    shifts.disconnect()
    cancelAnimationFrame(raf)
    cards.disconnect()
    unsubscribeReveal()
  }
}

/** What the probe records per handled frame. */
const recordFrame = (probe: StreamSocketProbe, kind: FrameKind, sentAt: number, handledAt: number) => {
  probe.framesHandled += 1
  probe.lastHandledAt = handledAt
  probe.maxFrameLagMs = Math.max(probe.maxFrameLagMs, Math.round(handledAt - sentAt))
  if (kind === 'step' && probe.firstStepAt === 0) probe.firstStepAt = handledAt
  if (kind === 'delta' && probe.firstDeltaAt === 0) probe.firstDeltaAt = handledAt
  if (kind === 'terminal') probe.completeAt = handledAt
}

/** Type the question into the real composer and press Enter, as a reader would. */
const sendFromComposer = (question: string): boolean => {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
  if (!textarea) return false
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setValue?.call(textarea, question)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  window.setTimeout(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  }, 50)
  return true
}

export default function StreamSocketPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const params = useSearchParams()
  const mode: ScriptMode = params.get('mode') === 'light' ? 'light' : 'heavy'
  const speed = Number(params.get('speed') ?? '1') || 1
  const autosend = params.get('autosend') !== '0'
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const script = buildNatScript(mode, speed)
    const probe: StreamSocketProbe = {
      mode,
      done: false,
      connected: false,
      sentAt: 0,
      firstStepAt: 0,
      firstDeltaAt: 0,
      firstCardAt: 0,
      completeAt: 0,
      settledAt: 0,
      framesScripted: script.frames.length,
      stepBytes: script.stepBytes,
      framesHandled: 0,
      heartbeats: 0,
      lastSentAt: 0,
      lastHandledAt: 0,
      maxFrameLagMs: 0,
      longTasks: [],
      rafBusyMs: 0,
      layoutShift: 0,
    }
    window.__streamSocket = probe
    const timers: number[] = []
    // Done once the answer settled, or 5 s after its terminal frame if it never reports settling.
    const finishWhenSettled = () => {
      if (probe.settledAt > 0 || (probe.completeAt > 0 && performance.now() - probe.completeAt > 5000)) {
        probe.done = true
        return
      }
      timers.push(window.setTimeout(finishWhenSettled, 100))
    }
    // Before anything mounts: the socket the chat opens must be the fake one.
    const uninstallServer = installFakeNatServer(
      script,
      {
        onOpen: () => (probe.connected = true),
        onUserMessage: (at) => {
          probe.sentAt = at
          finishWhenSettled()
        },
        onFrameHandled: (kind, sentAt, handledAt) => recordFrame(probe, kind, sentAt, handledAt),
        onHeartbeat: () => (probe.heartbeats += 1),
      },
      (lastSentAt) => (probe.lastSentAt = lastSentAt)
    )
    const restoreFetch = stubApiFetch()
    const stopObserving = observe(probe)

    const previous = useChatStore.getState()
    const persistedAs = useChatStore.persist.getOptions().name
    useChatStore.persist.setOptions({ name: HARNESS_STORAGE_KEY })
    const conversation = openConversation()
    useChatStore.setState({
      currentUserId: USER,
      currentConversation: conversation,
      conversations: [conversation],
      hasHydrated: true,
    })
    setReady(true)

    // Send once the chat's socket is open and the composer is on screen.
    const sendWhenOpen = () => {
      const open = document.querySelector('textarea') !== null && probe.connected
      if (open && sendFromComposer(script.question)) return
      timers.push(window.setTimeout(sendWhenOpen, 100))
    }
    if (autosend) timers.push(window.setTimeout(sendWhenOpen, 500))

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      stopObserving()
      restoreFetch()
      uninstallServer()
      useChatStore.setState(previous)
      useChatStore.persist.clearStorage()
      useChatStore.persist.setOptions({ name: persistedAs })
    }
  }, [mode, speed, autosend])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <div className="bg-background flex h-screen flex-col">
          {ready && (
            <>
              <ChatArea isAuthenticated />
              <InputArea isAuthenticated connectionMode="websocket" />
            </>
          )}
        </div>
      </AppConfigProvider>
    </I18nProvider>
  )
}
