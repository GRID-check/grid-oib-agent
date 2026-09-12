/**
 * The Aufgaben panel: fetched on mount, re-asked while visible.
 *
 * A task moves with no socket open in this tab — its worker finishes it, a
 * colleague reviews it — so a fetch-once list would wear a stale "Läuft"
 * until someone reloaded. The panel therefore polls on the job-history
 * cadence while visible, parks while hidden, and re-asks on focus. Polls are
 * quiet: no skeleton, no error state over a list the reader already has.
 */

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TASKS_POLL_MS, TasksPanel } from './tasks-panel'
import type { TaskWireRow } from '../lib/task-view'

const row = (overrides: Partial<TaskWireRow> = {}): TaskWireRow => ({
  id: 'task-1',
  kind: 'document',
  title: 'Aktenvermerk Fluchtwege',
  goal: null,
  status: 'running',
  review: null,
  reviewReason: null,
  filedDocumentId: null,
  conversationId: null,
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: '2026-09-01T10:00:00.000Z',
  finishedAt: null,
  error: null,
  ...overrides,
})

const fetchMock = vi.fn()

const flush = async (): Promise<void> => {
  await act(async () => {})
}

let visibility = 'visible'

describe('TasksPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tasks: [row()] }) })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    // @ts-expect-error restoring the prototype's own getter
    delete document.visibilityState
  })

  test('fetches on mount and lists the work', async () => {
    render(<TasksPanel projectId="proj-1" />)
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-1/tasks')
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
  })

  test('folds submission words to the planner word instead of rendering them raw', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        tasks: [
          row({ id: 't-sub', title: 'Eingereichte Arbeit', status: 'submitted' as TaskWireRow['status'] }),
          row({ id: 't-pen', title: 'Ausstehende Arbeit', status: 'pending' as TaskWireRow['status'] }),
        ],
      }),
    })
    render(<TasksPanel projectId="proj-1" />)
    await flush()

    expect(screen.getAllByTestId('task-status').map((chip) => chip.textContent)).toEqual([
      'Queued',
      'Queued',
    ])
    expect(screen.queryByText('Submitted')).not.toBeInTheDocument()
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  })

  test('re-asks on the poll cadence while visible', async () => {
    render(<TasksPanel projectId="proj-1" />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKS_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('parks while hidden and resumes with a refresh when visible again', async () => {
    render(<TasksPanel projectId="proj-1" />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKS_POLL_MS * 3)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    // The resume refreshes immediately rather than waiting for the interval.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('re-asks when the window regains focus', async () => {
    render(<TasksPanel projectId="proj-1" />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('a focus refresh landing mid-poll stays single-flight — no second load, no reorder', async () => {
    const pending: Array<(value: { ok: true; json: () => Promise<{ tasks: TaskWireRow[] }> }) => void> =
      []
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<{ ok: true; json: () => Promise<{ tasks: TaskWireRow[] }> }>((resolve) => {
          pending.push(resolve)
        })
    )
    render(<TasksPanel projectId="proj-1" />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Focus fires outside the chained poll while the mount load is still in
    // flight: without the guard this would start load #2, free to settle
    // before #1 and reorder the list.
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending[0]?.({ ok: true, json: async () => ({ tasks: [row()] }) })
    })
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a failed poll keeps the stale list instead of erroring', async () => {
    render(<TasksPanel projectId="proj-1" />)
    await flush()
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKS_POLL_MS)
    })

    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.queryByText('The task list could not be loaded')).not.toBeInTheDocument()
  })
})
