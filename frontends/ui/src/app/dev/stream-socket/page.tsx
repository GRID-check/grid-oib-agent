'use client'

/**
 * `/dev/stream-socket?speed=1` — one chat turn through the REAL socket client,
 * hook, store and components, with a scripted v2 server behind a stubbed
 * `window.WebSocket`.
 *
 * Why it exists: a production turn on the old wire pinned the main thread for
 * 47 s on hundreds of 17 to 31 KB step frames (`docs/design/chat-wire-v2.md`).
 * Here the v2 turn (`turn-script.ts`) goes through the socket client → the
 * chat hook → the store → `ChatArea`, the path the product takes, and the
 * probe reports frame bytes next to main-thread time: every frame but the
 * terminal under 4 KB, and a frame count that does not grow with the prompt.
 * Beside the cost it records what the reader sees move, until 2.5 s after the
 * settle (`layout-probe.ts`): layout shift split at the settle, the reading
 * line, the app's own scrolls and long animation frames.
 *
 * The answer is the recorded `oib2` turn, `speed` times its recorded pace.
 * The question is sent by the composer itself once the socket is open
 * (`autosend=0` leaves that to you). Everything measured lands in
 * `window.__streamSocket`; `scripts/measure-stream-socket.mjs` drives it and
 * prints the summary.
 *
 * The other lifecycles of a turn, each so it can be seen and measured
 * (times in ms after the question reached the server):
 *
 * - `scenario=` another shape of the turn (`_fixtures/v2-scenarios.ts`):
 *   `cards-only`, `masthead-first`, `shallow`, `opens-table`, `opens-card`,
 *   `one-line`, `long`, `two-turns` (the second question 600 ms after the
 *   first answer settled), `retract-with-card`, `rewrite` (the recording's own
 *   terminal, the retired whole-answer repair). Default `happy`, whose
 *   terminal continues the settle as the product's does today.
 * - `error=preack|steps|prose|finish` ends the turn with a `RUN_ERROR` there.
 * - `drop=<ms>` closes the socket as a lost network does; the client's ladder
 *   reconnects and its `attach` gets the frames it missed.
 * - `reload=<ms>` reloads the page; the server keeps the turn running, and the
 *   reloaded page's `attach{after_seq: 0}` replays it from the start.
 * - `switch=<ms>` opens another conversation, and this one again 1.5 s later.
 * - `toggle=open@<ms>,close@<ms>` clicks the Herleitung's header.
 * - `stop=<ms>` presses Stop.
 *
 * Development only. The numbers are `next dev` numbers: compare before with
 * after on the same server, never with production.
 */

import { useEffect, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea } from '@/features/layout/components'
import { InputArea } from '@/features/layout/components/InputArea'
import { useComposerMetrics } from '@/features/layout/hooks/use-composer-metrics'
import { ComposerScrim } from '@/features/layout/components/ComposerScrim'
import { selectThreadPhase } from '@/features/layout/lib/thread-phase'
import { motion } from '@/components/motion'
import { useChatStore } from '@/features/chat'
import { useAnswerRevealStore } from '@/features/chat/stores/answer-reveal-store'
import type { ChatMessage, Conversation } from '@/features/chat/types'
import { isErrorPhase, isStreamScenario, type ErrorPhase, type StreamScenario } from '../_fixtures/v2-scenarios'
import { answerMessageId, buildTurnScript, type FrameKind, type TurnScript } from './turn-script'
import { installFakeTurnServer, type FakeTurnServer, type ResumeTurn } from './fake-turn-server'
import { AFTER_SETTLE_MS, initialLayoutProbe, observeLayout, type LayoutProbe } from './layout-probe'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

// `useWebSocketChat` resets any other user id on mount, and the cross-user
// guard then empties the thread (gotchas.md).
const USER = 'default-user'
const HARNESS_STORAGE_KEY = 'aiq-chat-store:stream-socket'
const CONVERSATION_ID = 'stream-socket'
/** The conversation `switch=` opens while the turn runs. */
const OTHER_CONVERSATION_ID = 'stream-socket-other'
/** How long `switch=` stays in the other conversation. */
const SWITCH_AWAY_MS = 1_500
/** When `two-turns` asks its second question, after the first answer settled. */
const SECOND_QUESTION_AFTER_SETTLE_MS = 600
/** Where `reload=` leaves the running turn for the reloaded page (`sessionStorage`). */
const RESUME_KEY = 'stream-socket:resume'

/**
 * The first card on screen; A2UI and grid cards mark themselves. The recorded
 * `oib2` answer carries no card since its `legal_basis` was retired
 * (ADR-0069), so on it `firstCardAt` stays 0.
 */
const CARD_SELECTOR = '[data-a2ui-root], [data-a2ui-surface]'

/** One thing the harness did to the turn, for the probe's timeline. */
interface HarnessAction {
  /** Milliseconds after the question was sent. */
  t: number
  action: string
}

interface StreamSocketProbe extends LayoutProbe {
  scenario: StreamScenario
  error: ErrorPhase | null
  /** The latest turn's answer id: the reading line follows it. */
  answerId: string
  /** Questions the server received; `two-turns` asks two. */
  turnsAsked: number
  /** When the first answer settled, on `two-turns`, before the second question reset `settledAt`. */
  firstSettledAt: number
  /** This page load took a turn over from a reload (`reload=`). */
  resumed: boolean
  /** What the harness did, in order: drop, attach (with how many frames replayed), switch, toggle, stop, reload. */
  actions: HarnessAction[]
  /** Set `AFTER_SETTLE_MS` after the answer settled: the settle's own aftermath is part of the turn. */
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
  /** The largest frame but the settled snapshot and the terminal, and every frame together. */
  maxFrameBytes: number
  totalBytes: number
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
  /** Layout shift over the whole turn, the settle's aftermath included; split in `clsBeforeSettle`/`clsAfterSettle`. */
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
  const stopLayout = observeLayout(probe, probe)
  return () => {
    stopLayout()
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

interface HarnessParams {
  speed: number
  autosend: boolean
  scenario: StreamScenario
  error: ErrorPhase | null
  dropAt: number | null
  reloadAt: number | null
  switchAt: number | null
  stopAt: number | null
  toggles: { open: boolean; at: number }[]
}

const msParam = (value: string | null): number | null => {
  const ms = Number(value)
  return value !== null && Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** `open@3000,close@9000` → the clicks, in order. */
const parseToggles = (value: string | null): { open: boolean; at: number }[] =>
  (value ?? '')
    .split(',')
    .map((part) => /^(open|close)@(\d+)$/.exec(part.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ open: match[1] === 'open', at: Number(match[2]) }))

/**
 * The turn a `reload=` left behind, taken once per page load: the reloaded
 * page does not reload again, and a later manual reload starts fresh. Held in
 * the module because development runs the effect twice (Strict Mode), and the
 * second run must find what the first took out of storage.
 */
let resumeOfThisLoad: (ResumeTurn & { question: string }) | null | undefined
const takeResume = (): (ResumeTurn & { question: string }) | null => {
  if (resumeOfThisLoad !== undefined) return resumeOfThisLoad
  try {
    const raw = window.sessionStorage.getItem(RESUME_KEY)
    window.sessionStorage.removeItem(RESUME_KEY)
    resumeOfThisLoad = raw ? (JSON.parse(raw) as ResumeTurn & { question: string }) : null
  } catch {
    resumeOfThisLoad = null
  }
  return resumeOfThisLoad
}

/**
 * The Herleitung's header of the latest turn: the Collapsible trigger in the
 * panel's muted box (`ChatThinking`). The product has no hook for it, so this
 * leans on that structure; `aria-expanded`, since a closed Radix trigger drops
 * its `aria-controls`. When the structure changes the action reads
 * `(no header)` in the probe's `actions`.
 */
const herleitungTrigger = (): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>('.bg-muted > [data-state] > button[aria-expanded]')].at(-1) ?? null

/** Press the composer's Stop, as a reader would; the store's handler if the button is not there. */
const pressStop = (): void => {
  const button = document.querySelector('[data-glyph="stop"]')?.closest('button')
  if (button) button.click()
  else useChatStore.getState().stopStreaming?.()
}

/**
 * The harness's interruptions of the turn, scheduled from the first question
 * (`schedule` times from then). Each is written to the probe's `actions`.
 */
const scheduleInterruptions = (
  params: HarnessParams,
  probe: StreamSocketProbe,
  server: FakeTurnServer,
  script: TurnScript,
  schedule: (ms: number, run: () => void) => void
): void => {
  const note = (action: string) => probe.actions.push({ t: Math.round(performance.now() - probe.sentAt), action })
  if (params.dropAt !== null) {
    schedule(params.dropAt, () => {
      note('drop')
      server.drop()
    })
  }
  if (params.stopAt !== null) {
    schedule(params.stopAt, () => {
      note('stop')
      pressStop()
    })
  }
  for (const toggle of params.toggles) {
    schedule(toggle.at, () => {
      const trigger = herleitungTrigger()
      const isOpen = trigger?.getAttribute('data-state') === 'open'
      note(`${toggle.open ? 'open' : 'close'}${trigger ? (isOpen === toggle.open ? ' (already)' : '') : ' (no header)'}`)
      if (trigger && isOpen !== toggle.open) trigger.click()
    })
  }
  if (params.switchAt !== null) {
    schedule(params.switchAt, () => {
      note('switch away')
      useChatStore.getState().selectConversation(OTHER_CONVERSATION_ID)
    })
    schedule(params.switchAt + SWITCH_AWAY_MS, () => {
      note('switch back')
      useChatStore.getState().selectConversation(CONVERSATION_ID)
    })
  }
  if (params.reloadAt !== null) {
    schedule(params.reloadAt, () => {
      const running = server.running()
      if (!running) return note('reload (no turn running)')
      note('reload')
      try {
        const question = script.turns[running.index]?.question ?? script.question
        window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...running, question }))
      } catch {
        return note('reload (no sessionStorage)')
      }
      window.location.reload()
    })
  }
}

/** The thread as a reload finds it: the question, persisted, with no answer yet. */
const resumedConversation = (resume: ResumeTurn & { question: string }): Conversation => {
  const question: ChatMessage = {
    id: resume.turnId,
    role: 'user',
    content: resume.question,
    timestamp: new Date(resume.startedAtEpoch),
    messageType: 'user',
    authorUserId: USER,
  }
  return { ...openConversation(), messages: [question] }
}

const readParams = (params: URLSearchParams): HarnessParams => {
  const scenario = params.get('scenario')
  const error = params.get('error')
  return {
    speed: Number(params.get('speed') ?? '1') || 1,
    autosend: params.get('autosend') !== '0',
    scenario: isStreamScenario(scenario) ? scenario : 'happy',
    error: isErrorPhase(error) ? error : null,
    dropAt: msParam(params.get('drop')),
    reloadAt: msParam(params.get('reload')),
    switchAt: msParam(params.get('switch')),
    stopAt: msParam(params.get('stop')),
    toggles: parseToggles(params.get('toggle')),
  }
}

export default function StreamSocketPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const search = useSearchParams()
  // One key for the effect: a change to any parameter is a new harness run.
  const query = search.toString()
  const [ready, setReady] = useState(false)
  // The geometry `MainLayout` gives the composer, from the same hook.
  const isThreadEmpty = useChatStore((state) => selectThreadPhase(state) === 'empty')
  const { composerRef, columnVars, composerStyle, composerMotion } = useComposerMetrics(isThreadEmpty)

  useEffect(() => {
    const params = readParams(new URLSearchParams(query))
    const script = buildTurnScript(params.speed, { scenario: params.scenario, error: params.error ?? undefined })
    const resume = takeResume()
    const probe: StreamSocketProbe = {
      scenario: params.scenario,
      error: params.error,
      answerId: answerMessageId(resume?.index ?? 0),
      turnsAsked: resume ? resume.index + 1 : 0,
      firstSettledAt: 0,
      resumed: resume !== null,
      actions: [],
      done: false,
      connected: false,
      sentAt: 0,
      firstStepAt: 0,
      firstDeltaAt: 0,
      firstCardAt: 0,
      completeAt: 0,
      settledAt: 0,
      framesScripted: script.turns.reduce((sum, turn) => sum + turn.frames.length, 0),
      stepBytes: script.stepBytes,
      maxFrameBytes: script.maxFrameBytes,
      totalBytes: script.totalBytes,
      framesHandled: 0,
      heartbeats: 0,
      lastSentAt: 0,
      lastHandledAt: 0,
      maxFrameLagMs: 0,
      longTasks: [],
      rafBusyMs: 0,
      layoutShift: 0,
      ...initialLayoutProbe(),
    }
    window.__streamSocket = probe
    const timers: number[] = []
    const later = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms))
    const allAsked = () => probe.turnsAsked >= script.turns.length
    // Done `AFTER_SETTLE_MS` after the last answer settled, or 5 s after its
    // terminal frame if it never reports settling (a failed or stopped turn).
    // Not AT the settle: the Herleitung collapses and the footer lands in the
    // frames after it, and a probe that stopped there reported a turn whose
    // worst shift it never saw.
    const finishWhenSettled = () => {
      const now = performance.now()
      const settled = probe.settledAt > 0 && now - probe.settledAt > AFTER_SETTLE_MS
      const ended = probe.completeAt > 0 && now - probe.completeAt > 5000
      if (allAsked() && (settled || ended)) {
        probe.done = true
        return
      }
      later(100, finishWhenSettled)
    }
    // The next question of `two-turns`, once the answer before it settled.
    const askNextWhenSettled = () => {
      if (allAsked()) return
      if (probe.settledAt > 0) {
        const asked = probe.turnsAsked
        const send = () => {
          if (probe.turnsAsked !== asked) return
          sendFromComposer(script.turns[asked].question)
          // A composer still busy with the first turn ignores Enter: ask again
          // until the server has the question.
          later(1_500, send)
        }
        later(SECOND_QUESTION_AFTER_SETTLE_MS, send)
        return
      }
      later(100, askNextWhenSettled)
    }
    // Before anything mounts: the socket the chat opens must be the fake one.
    const server = installFakeTurnServer(
      script,
      {
        onOpen: () => (probe.connected = true),
        onUserMessage: (at, index) => {
          probe.turnsAsked = index + 1
          probe.answerId = answerMessageId(index)
          if (index > 0) {
            // A new turn: the settle the split and `done` wait for is its own.
            probe.firstSettledAt = probe.settledAt
            probe.settledAt = 0
            probe.completeAt = 0
            return
          }
          probe.sentAt = at
          finishWhenSettled()
          askNextWhenSettled()
          scheduleInterruptions(params, probe, server, script, later)
        },
        onFrameHandled: (kind, sentAt, handledAt) => recordFrame(probe, kind, sentAt, handledAt),
        onHeartbeat: () => (probe.heartbeats += 1),
        onAttach: (afterSeq, frames) =>
          probe.actions.push({ t: Math.round(performance.now() - probe.sentAt), action: `attach after_seq=${afterSeq} replay=${frames}` }),
      },
      (lastSentAt) => (probe.lastSentAt = lastSentAt),
      { resume: resume ?? undefined }
    )
    const restoreFetch = stubApiFetch()
    const stopObserving = observe(probe)

    const previous = useChatStore.getState()
    const persistedAs = useChatStore.persist.getOptions().name
    useChatStore.persist.setOptions({ name: HARNESS_STORAGE_KEY })
    const conversation = resume ? resumedConversation(resume) : openConversation()
    const other: Conversation = { ...openConversation(), id: OTHER_CONVERSATION_ID, title: 'Another conversation' }
    useChatStore.setState({
      currentUserId: USER,
      currentConversation: conversation,
      conversations: [conversation, other],
      hasHydrated: true,
    })
    if (resume) {
      // As a reload finds the thread: its newest question has no answer, so
      // the store marks the turn resumable and the socket attaches it from seq 0.
      useChatStore.getState().restoreSessionState(conversation)
      probe.sentAt = performance.now()
      finishWhenSettled()
      askNextWhenSettled()
    }
    setReady(true)

    // Send once the chat's socket is open and the composer is on screen.
    const sendWhenOpen = () => {
      const open = document.querySelector('textarea') !== null && probe.connected
      if (open && sendFromComposer(script.question)) return
      later(100, sendWhenOpen)
    }
    if (params.autosend && !resume) later(500, sendWhenOpen)

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      stopObserving()
      restoreFetch()
      server.uninstall()
      useChatStore.setState(previous)
      useChatStore.persist.clearStorage()
      useChatStore.persist.setOptions({ name: persistedAs })
    }
  }, [query])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        {/* The product's chat column (`MainLayout`): the composer FLOATS over
            the thread's foot, with the product's scrims, and publishes its height, which the thread pads
            for and the jump button and status dock sit above. In flow, below
            the thread, it measured a layout the product does not have, and
            everything placed from `--composer-h` floated mid-screen. */}
        <div className="bg-background relative flex h-screen flex-col overflow-hidden" style={columnVars}>
          {ready && (
            <>
              <ChatArea isAuthenticated />
              <ComposerScrim />
              <motion.div
                ref={composerRef}
                className="absolute inset-x-0 z-10 flex flex-col"
                style={composerStyle}
                {...composerMotion}
              >
                <InputArea isAuthenticated connectionMode="websocket" />
              </motion.div>
            </>
          )}
        </div>
      </AppConfigProvider>
    </I18nProvider>
  )
}
