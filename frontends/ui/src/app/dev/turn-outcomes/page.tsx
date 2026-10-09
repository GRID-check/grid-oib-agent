'use client'

/**
 * `/dev/turn-outcomes?scenario=handed_off&auto=1` — every way a turn ends other
 * than a plain answer, played through the REAL socket client, hook, fold,
 * projection, store and `ChatArea`, with a scripted v2 server behind a stubbed
 * `window.WebSocket` (`./fake-socket.ts`).
 *
 * The scenarios (`./scenarios.ts`): a hand-off to a run, an answer retracted
 * mid-stream, `RUN_ERROR` during the steps, mid-stream and at the finish, a
 * question the server never acknowledges (the 30 s ack timeout), Stop pressed
 * before the first step, during the steps and mid-reveal, a full job queue, a
 * choice prompt answered, a plan approved and handed off, and a file proposal
 * accepted. Each is what a reader sees when a turn does not simply
 * answer, which is exactly where the thread used to jump, lose its words or
 * say the wrong thing (wave-2 outcomes audit). The note under the picker says
 * what to watch for.
 *
 * `auto=1` answers prompts and presses the proposal's button by itself, for a
 * headless capture; without it the page waits for you. `window.__turnOutcomes`
 * records every body the server sent, with its time.
 *
 * Development only (the `/dev` layout 404s elsewhere).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea } from '@/features/layout/components'
import { InputArea } from '@/features/layout/components/InputArea'
import { useChatStore } from '@/features/chat'
import type { Conversation } from '@/features/chat/types'
import { installFakeSocket, stubApi } from './fake-socket'
import { PROJECT_ID, SCENARIO_IDS, SCENARIOS, type ScenarioId } from './scenarios'

const config: AppConfig = { authRequired: false, fileUpload: getFileUploadConfigFromEnv() }

// `useWebSocketChat` resets any other user id on mount, and the cross-user
// guard then empties the thread (gotchas.md).
const USER = 'default-user'
const HARNESS_STORAGE_KEY = 'aiq-chat-store:turn-outcomes'
const CONVERSATION_ID = 'turn-outcomes'

interface TurnOutcomesProbe {
  scenario: ScenarioId
  sentAt: number
  bodies: { t: number; type: string; name?: string }[]
}

declare global {
  interface Window {
    __turnOutcomes?: TurnOutcomesProbe
  }
}

const openConversation = (project: boolean): Conversation => ({
  id: CONVERSATION_ID,
  userId: USER,
  projectId: project ? PROJECT_ID : null,
  title: 'Turn outcomes',
  messages: [],
  createdAt: new Date(2026, 9, 1, 9),
  updatedAt: new Date(2026, 9, 1, 9),
})

/** Type the question into the real composer and press Enter, as a reader would. */
const sendFromComposer = (question: string): boolean => {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
  if (!textarea) return false
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    textarea,
    question
  )
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  window.setTimeout(() => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    )
  }, 50)
  return true
}

/** What `auto=1` does once a prompt or a card is on screen: what a reader would. */
const autoAnswer = (id: ScenarioId): void => {
  const respond = useChatStore.getState().respondToInteractionFn
  if (id === 'hitl_choice') respond?.('gk4')
  if (id === 'hitl_plan') respond?.('approve')
  if (id === 'proposal_accept') {
    const accept = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Übernehmen')
    )
    accept?.click()
  }
}

const isScenario = (value: string | null): value is ScenarioId =>
  SCENARIO_IDS.includes(value as ScenarioId)

export default function TurnOutcomesPage() {
  const params = useSearchParams()
  const requested = params.get('scenario')
  const id: ScenarioId = isScenario(requested) ? requested : 'handed_off'
  const auto = params.get('auto') === '1'
  const scenario = SCENARIOS[id]
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const probe: TurnOutcomesProbe = { scenario: id, sentAt: 0, bodies: [] }
    window.__turnOutcomes = probe
    const timers: number[] = []
    const at = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms))
    let connected = false

    // Before anything mounts: the socket the chat opens must be the fake one.
    const uninstallSocket = installFakeSocket(scenario, {
      onOpen: () => (connected = true),
      onBody: (body) => {
        probe.bodies.push({
          t: Math.round(performance.now() - probe.sentAt),
          type: String(body.type),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
        })
        const asks =
          body.name === 'interaction_request' || (body.name === 'card' && id === 'proposal_accept')
        if (auto && asks) at(1500, () => autoAnswer(id))
      },
    })
    const restoreFetch = stubApi(scenario)

    const previous = useChatStore.getState()
    const persistedAs = useChatStore.persist.getOptions().name
    useChatStore.persist.setOptions({ name: HARNESS_STORAGE_KEY })
    const conversation = openConversation(Boolean(scenario.project))
    useChatStore.setState({
      currentUserId: USER,
      currentConversation: conversation,
      conversations: [conversation],
      projectId: scenario.project ? PROJECT_ID : null,
      hasHydrated: true,
    })
    setReady(true)

    const sendWhenOpen = () => {
      if (connected && sendFromComposer(scenario.question)) {
        probe.sentAt = performance.now()
        // Stop, as the composer's button does it.
        if (scenario.stopAt !== undefined)
          at(scenario.stopAt, () => useChatStore.getState().stopStreaming?.())
        return
      }
      at(100, sendWhenOpen)
    }
    at(500, sendWhenOpen)

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      restoreFetch()
      uninstallSocket()
      useChatStore.setState(previous)
      useChatStore.persist.clearStorage()
      useChatStore.persist.setOptions({ name: persistedAs })
    }
  }, [id, auto, scenario])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <div className="bg-background flex h-screen flex-col">
          <nav
            className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs"
            aria-label="Scenarios"
          >
            {SCENARIO_IDS.map((scenarioId) => (
              <Link
                key={scenarioId}
                href={`/dev/turn-outcomes?scenario=${scenarioId}${auto ? '&auto=1' : ''}`}
                className={
                  scenarioId === id
                    ? 'text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }
                // A fresh page per scenario: one scripted turn per socket.
                prefetch={false}
                onClick={(event) => {
                  event.preventDefault()
                  window.location.assign(
                    `/dev/turn-outcomes?scenario=${scenarioId}${auto ? '&auto=1' : ''}`
                  )
                }}
              >
                {SCENARIOS[scenarioId].label}
              </Link>
            ))}
          </nav>
          <p className="text-muted-foreground px-4 py-2 text-xs" data-testid="turn-outcomes-note">
            {scenario.note}
          </p>
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
