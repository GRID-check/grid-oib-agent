/**
 * The block's data half: the stored ledger until the stream says otherwise,
 * one subscription per block, closed on the terminal snapshot and on unmount,
 * and nothing at all once the run is over.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/runs/run-view-client', () => ({ fetchRunView: vi.fn(), cancelRun: vi.fn() }))
vi.mock('@/adapters/api/deep-research-client', () => ({ createDeepResearchClient: vi.fn() }))

import {
  createDeepResearchClient,
  type DeepResearchCallbacks,
  type DeepResearchStreamOptions,
} from '@/adapters/api/deep-research-client'
import type { RunLedger, RunView } from '@/lib/runs/run-ledger-types'
import { cancelRun, fetchRunView } from '@/lib/runs/run-view-client'
import { useRunLedger } from './use-run-ledger'

const RUN = 'run-1'

const ledger = (overrides: Partial<RunLedger> = {}): RunLedger => ({
  runId: RUN,
  status: 'laeuft',
  phases: [{ phase: 'recherchieren', startedAt: '2026-09-16T08:00:00.000Z' }],
  steps: [],
  startedAt: '2026-09-16T08:00:00.000Z',
  updatedAt: '2026-09-16T08:00:05.000Z',
  ...overrides,
})

const view = (overrides: Partial<RunView> = {}): RunView => ({
  runId: RUN,
  backendJobId: 'job-1',
  conversationId: 's_conv',
  messageId: 'msg-1',
  status: 'running',
  ledger: null,
  ...overrides,
})

/** The fake client: records the callbacks so a test can emit into them. */
let connected: Array<{ options: DeepResearchStreamOptions; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>

const callbacksOf = (index = 0): DeepResearchCallbacks => connected[index].options.callbacks

beforeEach(() => {
  connected = []
  vi.mocked(createDeepResearchClient).mockImplementation((options) => {
    const entry = { options, connect: vi.fn(), disconnect: vi.fn() }
    connected.push(entry)
    return {
      connect: entry.connect,
      disconnect: entry.disconnect,
      isConnected: () => true,
      getLastEventId: () => null,
    }
  })
  vi.mocked(fetchRunView).mockResolvedValue(view())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useRunLedger', () => {
  it('shows the stored ledger and touches no network once the run is over', () => {
    const stored = ledger({ status: 'fertig', finishedAt: '2026-09-16T08:10:00.000Z' })

    const { result } = renderHook(() => useRunLedger({ message: { runLedger: stored }, projectId: 'p1' }))

    expect(result.current.ledger).toBe(stored)
    expect(result.current.live).toBe(false)
    expect(fetchRunView).not.toHaveBeenCalled()
    expect(createDeepResearchClient).not.toHaveBeenCalled()
  })

  it('opens the run’s own stream with replay and replaces the ledger on every snapshot', async () => {
    const { result } = renderHook(() => useRunLedger({ message: { runLedger: ledger() }, projectId: 'p1' }))

    await waitFor(() => expect(connected).toHaveLength(1))
    expect(fetchRunView).toHaveBeenCalledWith('p1', RUN)
    // No last event id: the proxy replays from the first flush, and the newest
    // snapshot is the one that lands.
    expect(connected[0].options).toMatchObject({ jobId: 'job-1' })
    expect(connected[0].options.lastEventId).toBeUndefined()
    expect(connected[0].connect).toHaveBeenCalledTimes(1)
    expect(result.current.live).toBe(true)

    const snapshot = ledger({
      updatedAt: '2026-09-16T08:01:00.000Z',
      steps: [
        {
          id: 'batch-1',
          phase: 'recherchieren',
          intent: 'OIB 2 auf Fluchtweglängen prüfen',
          startedAt: '2026-09-16T08:00:30.000Z',
          docs: [{ name: 'OIB-RL_2.pdf', loci: ['Pkt. 4.2'] }],
        },
      ],
    })
    act(() => callbacksOf().onLedger?.(snapshot))

    expect(result.current.ledger).toEqual(snapshot)
    expect(connected[0].disconnect).not.toHaveBeenCalled()
  })

  it('closes the stream on the terminal snapshot and goes quiet', async () => {
    const { result } = renderHook(() => useRunLedger({ message: { runLedger: ledger() }, projectId: 'p1' }))
    await waitFor(() => expect(connected).toHaveLength(1))

    act(() =>
      callbacksOf().onLedger?.(
        ledger({
          status: 'fertig',
          updatedAt: '2026-09-16T08:10:00.000Z',
          finishedAt: '2026-09-16T08:10:00.000Z',
          result: { filedAt: '2026-09-16T08:10:00.000Z' },
        }),
      ),
    )

    expect(result.current.ledger?.status).toBe('fertig')
    expect(result.current.live).toBe(false)
    expect(connected[0].disconnect).toHaveBeenCalled()
    // The terminal state re-runs the effect to a no-op: one fetch, one client.
    expect(fetchRunView).toHaveBeenCalledTimes(1)
    expect(createDeepResearchClient).toHaveBeenCalledTimes(1)
  })

  it('never moves the block backwards: a replayed snapshot older than what is shown is dropped', async () => {
    const stored = ledger({ updatedAt: '2026-09-16T08:05:00.000Z' })
    const { result } = renderHook(() => useRunLedger({ message: { runLedger: stored }, projectId: 'p1' }))
    await waitFor(() => expect(connected).toHaveLength(1))

    act(() => callbacksOf().onLedger?.(ledger({ updatedAt: '2026-09-16T08:00:10.000Z', phases: [] })))

    expect(result.current.ledger).toBe(stored)
  })

  it('drops a snapshot the sanitiser rejects', async () => {
    const stored = ledger()
    const { result } = renderHook(() => useRunLedger({ message: { runLedger: stored }, projectId: 'p1' }))
    await waitFor(() => expect(connected).toHaveLength(1))

    act(() => callbacksOf().onLedger?.('lief gut'))

    expect(result.current.ledger).toBe(stored)
  })

  it('takes the fetched ledger when it is newer, and does not stream a run that has already ended', async () => {
    const finished = ledger({
      status: 'fehlgeschlagen',
      updatedAt: '2026-09-16T08:12:00.000Z',
      finishedAt: '2026-09-16T08:12:00.000Z',
      error: { reason: 'Budget aufgebraucht', completedBefore: ['planen'] },
    })
    vi.mocked(fetchRunView).mockResolvedValue(view({ ledger: finished }))

    const { result } = renderHook(() => useRunLedger({ message: { runLedger: ledger() }, projectId: 'p1' }))

    await waitFor(() => expect(result.current.ledger?.status).toBe('fehlgeschlagen'))
    expect(createDeepResearchClient).not.toHaveBeenCalled()
    expect(result.current.live).toBe(false)
  })

  it('fails open: a refused read leaves the stored ledger on screen', async () => {
    vi.mocked(fetchRunView).mockRejectedValue(new Error('404'))
    const stored = ledger()

    const { result } = renderHook(() => useRunLedger({ message: { runLedger: stored }, projectId: 'p1' }))

    await waitFor(() => expect(fetchRunView).toHaveBeenCalled())
    expect(result.current.ledger).toBe(stored)
    expect(result.current.live).toBe(false)
    expect(createDeepResearchClient).not.toHaveBeenCalled()
  })

  it('disconnects on unmount', async () => {
    const { unmount } = renderHook(() => useRunLedger({ message: { runLedger: ledger() }, projectId: 'p1' }))
    await waitFor(() => expect(connected).toHaveLength(1))

    unmount()

    expect(connected[0].disconnect).toHaveBeenCalledTimes(1)
  })

  it('holds one subscription per block, keyed by run', async () => {
    const other = ledger({ runId: 'run-2' })
    vi.mocked(fetchRunView).mockImplementation(async (_project, runId) => view({ runId, backendJobId: `job-${runId}` }))

    renderHook(() => useRunLedger({ message: { runLedger: ledger() }, projectId: 'p1' }))
    renderHook(() => useRunLedger({ message: { runLedger: other }, projectId: 'p1' }))

    await waitFor(() => expect(connected).toHaveLength(2))
    expect(connected.map((entry) => entry.options.jobId).sort()).toEqual(['job-run-1', 'job-run-2'])
  })

  it('offers no way to stop a run that is over, or one it cannot reach', () => {
    const done = renderHook(() =>
      useRunLedger({ message: { runLedger: ledger({ status: 'fertig' }) }, projectId: 'p1' }),
    )
    expect(done.result.current.cancel).toBeNull()

    const unreachable = renderHook(() => useRunLedger({ message: { runLedger: ledger() } }))
    expect(unreachable.result.current.cancel).toBeNull()
  })

  it('stops the run through the read door and takes the ledger the cancel returns', async () => {
    const stopped = ledger({ status: 'abgebrochen', updatedAt: '2026-09-16T08:02:00.000Z' })
    vi.mocked(cancelRun).mockResolvedValue(view({ status: 'cancelled', ledger: stopped }))

    const { result } = renderHook(() => useRunLedger({ message: { runLedger: ledger() }, projectId: 'p1' }))
    await waitFor(() => expect(result.current.cancel).not.toBeNull())

    await act(async () => {
      await result.current.cancel?.()
    })

    expect(cancelRun).toHaveBeenCalledWith('p1', RUN)
    expect(result.current.ledger).toEqual(stopped)
    expect(result.current.cancel).toBeNull()
  })

  it('fails open when the stop is refused: the run goes on saying what the ledger says', async () => {
    const stored = ledger()
    vi.mocked(cancelRun).mockRejectedValue(new Error('conflict'))

    const { result } = renderHook(() => useRunLedger({ message: { runLedger: stored }, projectId: 'p1' }))
    await waitFor(() => expect(result.current.cancel).not.toBeNull())

    await act(async () => {
      await result.current.cancel?.()
    })

    expect(result.current.ledger).toEqual(stored)
    expect(result.current.cancel).not.toBeNull()
  })
})
