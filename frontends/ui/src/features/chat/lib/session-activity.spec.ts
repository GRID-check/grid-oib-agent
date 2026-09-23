/**
 * @vitest-environment node
 */
/**
 * Tests for session-activity utility functions: what a thread's stored run
 * ledgers say about it.
 */

import { describe, it, expect } from 'vitest'
import { emptyRunLedger, failRun, finishRun, setRunStatus } from '@/lib/runs/run-ledger'
import type { RunStatus } from '@/lib/runs/run-ledger-types'
import {
  hasFinishedRun,
  hasLiveRun,
  hasNoUserChatMessages,
  liveRunMessages,
} from './session-activity'
import type { ChatMessage } from '../types'

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  role: 'assistant',
  content: '',
  timestamp: new Date(),
  ...overrides,
})

const runMessage = (id: string, status: RunStatus): ChatMessage =>
  makeMessage({
    id,
    messageType: 'agent_response',
    runLedger: setRunStatus(emptyRunLedger(`run-${id}`), status),
  })

describe('hasNoUserChatMessages', () => {
  it('returns true when there are no user messages', () => {
    expect(hasNoUserChatMessages([])).toBe(true)
    expect(
      hasNoUserChatMessages([
        makeMessage({ messageType: 'status' }),
        makeMessage({ id: 'a', messageType: 'agent_response' }),
      ])
    ).toBe(true)
  })

  it('returns false when a user message exists', () => {
    expect(hasNoUserChatMessages([makeMessage({ role: 'user', messageType: 'user' })])).toBe(false)
  })
})

describe('hasLiveRun', () => {
  it('is false for a thread without runs', () => {
    expect(hasLiveRun([])).toBe(false)
    expect(hasLiveRun([makeMessage({ messageType: 'agent_response' })])).toBe(false)
  })

  it.each([['angelegt'], ['laeuft'], ['wartet']] as const)('is true while a run is %s', (status) => {
    expect(hasLiveRun([runMessage('a', status)])).toBe(true)
  })

  it.each([['fertig'], ['fehlgeschlagen'], ['abgebrochen'], ['unterbrochen']] as const)(
    'is false once every run is %s',
    (status) => {
      expect(hasLiveRun([runMessage('a', status)])).toBe(false)
    }
  )

  it('is true when ANY run in the thread is live, not only the latest', () => {
    expect(hasLiveRun([runMessage('a', 'laeuft'), runMessage('b', 'fertig')])).toBe(true)
  })

  it('reads a ledger with no status word off its terminal fields', () => {
    const done = makeMessage({
      messageType: 'agent_response',
      runLedger: finishRun(emptyRunLedger('run-x'), { filedAt: '2026-01-01T00:00:00.000Z' }),
    })
    const failed = makeMessage({
      id: 'f',
      messageType: 'agent_response',
      runLedger: failRun(emptyRunLedger('run-y'), 'Abbruch'),
    })
    expect(hasLiveRun([done, failed])).toBe(false)
  })
})

describe('liveRunMessages', () => {
  it('returns only the run messages whose run is still live', () => {
    const live = runMessage('a', 'laeuft')
    const done = runMessage('b', 'fertig')
    const chat = makeMessage({ id: 'c', messageType: 'agent_response' })
    expect(liveRunMessages([chat, live, done])).toEqual([live])
  })
})

describe('hasFinishedRun', () => {
  it('is true when a run finished with a report', () => {
    expect(hasFinishedRun([runMessage('a', 'fertig')])).toBe(true)
  })

  it('is false for a failed, stopped or still-going run', () => {
    expect(hasFinishedRun([runMessage('a', 'fehlgeschlagen')])).toBe(false)
    expect(hasFinishedRun([runMessage('a', 'abgebrochen')])).toBe(false)
    expect(hasFinishedRun([runMessage('a', 'laeuft')])).toBe(false)
  })
})
