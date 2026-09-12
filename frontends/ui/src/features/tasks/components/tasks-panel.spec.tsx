/**
 * The Aufgaben panel: fetched on mount, re-asked while visible.
 *
 * A task moves with no socket open in this tab — its worker finishes it, a
 * colleague reviews it — so a fetch-once list would wear a stale "Läuft"
 * until someone reloaded. The panel therefore polls the tasks on the
 * job-history cadence while visible, parks while hidden, and re-asks on
 * focus. Polls are quiet: no skeleton, no error state over a list the reader
 * already has. Schedules ride along (loaded on mount, refreshed on focus and
 * after every save), because the templates group is jobs with a timer.
 */

import type { ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TASKS_POLL_MS, TasksPanel } from './tasks-panel'
import type { TaskWireRow } from '../lib/task-view'

// The header slot belongs to the section frame; unit tests have none.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

// The schedule flow re-homes the real builder; the panel's half is the mode
// switch and the reload after a save — not the builder's own form.
vi.mock('@/features/jobs/components/job-builder', () => ({
  JobBuilder: ({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) => (
    <div data-testid="job-builder-stub">
      <button type="button" onClick={onSaved}>
        save-stub
      </button>
      <button type="button" onClick={onCancel}>
        cancel-stub
      </button>
    </div>
  ),
}))

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

const recurringJob = {
  id: 'job-1',
  projectId: 'proj-1',
  name: 'Wöchentlicher OIB-Check',
  prompt: 'Prüfe die Brandschutzpunkte.',
  skillName: null,
  skillSnapshot: null,
  output: 'deep-research',
  dataSources: null,
  enabled: true,
  scheduleCron: '0 6 * * 1',
  scheduleTimezone: 'Europe/Vienna',
  nextRunAt: '2026-09-14T06:00:00.000Z',
  lastRunAt: null,
  createdBy: 'user_anna',
  createdByEmail: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const manualJob = { ...recurringJob, id: 'job-man', name: 'Einmal prüfen', scheduleCron: null }

let tasksPayload: { tasks: TaskWireRow[] } = { tasks: [row()] }
let jobsPayload: { jobs: unknown[] } = { jobs: [] }

const fetchMock = vi.fn((url: unknown): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
  if (typeof url === 'string' && url.endsWith('/jobs')) {
    return Promise.resolve({ ok: true, json: async () => jobsPayload })
  }
  return Promise.resolve({ ok: true, json: async () => tasksPayload })
})

const flush = async (): Promise<void> => {
  await act(async () => {})
}

const tasksCalls = (): string[] =>
  fetchMock.mock.calls
    .map(([url]) => url)
    .filter((url): url is string => typeof url === 'string' && !url.endsWith('/jobs'))

const jobsCalls = (): string[] =>
  fetchMock.mock.calls
    .map(([url]) => url)
    .filter((url): url is string => typeof url === 'string' && url.endsWith('/jobs'))

let visibility = 'visible'

const renderPanel = (props: { canManageJobs?: boolean; canChatInProject?: boolean } = {}) =>
  render(
    <TasksPanel
      projectId="proj-1"
      projectCollection="col-1"
      canManageJobs={props.canManageJobs ?? true}
      canChatInProject={props.canChatInProject ?? true}
    />
  )

describe('TasksPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    tasksPayload = { tasks: [row()] }
    jobsPayload = { jobs: [] }
    fetchMock.mockClear()
    fetchMock.mockImplementation((url: unknown): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      if (typeof url === 'string' && url.endsWith('/jobs')) {
        return Promise.resolve({ ok: true, json: async () => jobsPayload })
      }
      return Promise.resolve({ ok: true, json: async () => tasksPayload })
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.history.replaceState(null, '', '/')
    // @ts-expect-error restoring the prototype's own getter
    delete document.visibilityState
  })

  test('fetches tasks and schedules on mount and lists the work', async () => {
    renderPanel()
    await flush()

    expect(tasksCalls()).toEqual(['/api/projects/proj-1/tasks'])
    expect(jobsCalls()).toEqual(['/api/projects/proj-1/jobs'])
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
  })

  test('folds submission words to the planner word instead of rendering them raw', async () => {
    tasksPayload = {
      tasks: [
        row({ id: 't-sub', title: 'Eingereichte Arbeit', status: 'submitted' as TaskWireRow['status'] }),
        row({ id: 't-pen', title: 'Ausstehende Arbeit', status: 'pending' as TaskWireRow['status'] }),
      ],
    }
    renderPanel()
    await flush()

    expect(screen.getAllByTestId('task-status').map((chip) => chip.textContent)).toEqual([
      'Queued',
      'Queued',
    ])
    expect(screen.queryByText('Submitted')).not.toBeInTheDocument()
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  })

  test('recurring schedules render as templates; manual jobs stay on the Jobs tab', async () => {
    jobsPayload = { jobs: [recurringJob, manualJob] }
    renderPanel()
    await flush()

    expect(screen.getByTestId('template-row')).toBeInTheDocument()
    expect(screen.getByTestId('template-cadence')).toHaveTextContent(
      'Weekly on Monday at 06:00 · Europe/Vienna',
    )
    expect(screen.queryByText('Einmal prüfen')).not.toBeInTheDocument()
  })

  test('re-asks on the poll cadence while visible', async () => {
    renderPanel()
    await flush()
    expect(tasksCalls()).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKS_POLL_MS)
    })
    expect(tasksCalls()).toHaveLength(2)
  })

  test('parks while hidden and resumes with a refresh when visible again', async () => {
    renderPanel()
    await flush()
    expect(tasksCalls()).toHaveLength(1)

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKS_POLL_MS * 3)
    })
    expect(tasksCalls()).toHaveLength(1)

    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    // The resume refreshes immediately rather than waiting for the interval.
    expect(tasksCalls()).toHaveLength(2)
  })

  test('re-asks when the window regains focus', async () => {
    renderPanel()
    await flush()
    expect(tasksCalls()).toHaveLength(1)

    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(tasksCalls()).toHaveLength(2)
  })

  test('a focus refresh landing mid-poll stays single-flight — no second load, no reorder', async () => {
    const pending: Array<(value: { ok: true; json: () => Promise<unknown> }) => void> = []
    fetchMock.mockImplementationOnce(
      (url: unknown) =>
        new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
          // Only the tasks request parks; the schedules request resolves.
          if (typeof url === 'string' && url.endsWith('/jobs')) {
            resolve({ ok: true, json: async () => jobsPayload })
          } else {
            pending.push(resolve)
          }
        })
    )
    renderPanel()
    await flush()
    expect(tasksCalls()).toHaveLength(1)

    // Focus fires outside the chained poll while the mount load is still in
    // flight: without the guard this would start load #2, free to settle
    // before #1 and reorder the list.
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(tasksCalls()).toHaveLength(1)

    await act(async () => {
      pending[0]?.({ ok: true, json: async () => ({ tasks: [row()] }) })
    })
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(tasksCalls()).toHaveLength(1)
  })

  test('a failed poll keeps the stale list instead of erroring', async () => {
    renderPanel()
    await flush()
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKS_POLL_MS)
    })

    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.queryByText('The task list could not be loaded')).not.toBeInTheDocument()
  })

  test('create is split by capability: chat delegation for all, schedules gated', async () => {
    renderPanel({ canManageJobs: true })
    await flush()

    const delegate = screen.getByTestId('tasks-delegate')
    expect(delegate).toHaveAttribute('href', '/app/projects/proj-1/chat')
    expect(delegate).toHaveTextContent('Delegate')
    expect(screen.getByTestId('tasks-new-schedule')).toBeInTheDocument()
  })

  test('without project:chat Delegieren is disabled with the locked-composer reason', async () => {
    renderPanel({ canChatInProject: false })
    await flush()

    // No link into a dead end: a viewer would land in a locked composer, so
    // the gesture is disabled and says why — reusing the locked composer's
    // own copy, not a rewording. The title rides the wrapping span because a
    // disabled button takes no pointer events.
    const delegate = screen.getByTestId('tasks-delegate')
    expect(delegate.tagName).toBe('BUTTON')
    expect(delegate).toBeDisabled()
    expect(delegate.parentElement).toHaveAttribute(
      'title',
      'Piloti is unavailable in this project for you right now. If you have read-only access, a project admin can grant you the Contributor role.'
    )
  })

  test('without project:skills:manage the schedule flow is hidden, not disabled', async () => {
    renderPanel({ canManageJobs: false })
    await flush()

    // Delegating stays — it happens in chat under its own permission.
    expect(screen.getByTestId('tasks-delegate')).toBeInTheDocument()
    expect(screen.queryByTestId('tasks-new-schedule')).toBeNull()
    expect(screen.queryByTestId('job-builder-stub')).toBeNull()
  })

  test('“New schedule” opens the re-homed builder; saving reloads the schedules', async () => {
    renderPanel({ canManageJobs: true })
    await flush()
    expect(jobsCalls()).toHaveLength(1)

    fireEvent.click(screen.getByTestId('tasks-new-schedule'))
    expect(screen.getByTestId('job-builder-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('task-row')).toBeNull()

    fireEvent.click(screen.getByText('save-stub'))
    await flush()
    expect(screen.getByTestId('task-row')).toBeInTheDocument()
    expect(jobsCalls()).toHaveLength(2)
  })

  test('cancelling the builder returns to the list without reloading', async () => {
    renderPanel({ canManageJobs: true })
    await flush()

    fireEvent.click(screen.getByTestId('tasks-new-schedule'))
    fireEvent.click(screen.getByText('cancel-stub'))
    expect(screen.getByTestId('task-row')).toBeInTheDocument()
    expect(jobsCalls()).toHaveLength(1)
  })

  test('selecting a run opens its detail with the result links', async () => {
    tasksPayload = {
      tasks: [row({ filedDocumentId: 'doc-9', conversationId: 'conv-3' })],
    }
    renderPanel()
    await flush()

    fireEvent.click(screen.getByTestId('task-title'))
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    expect(screen.getByTestId('task-detail-result-doc')).toHaveAttribute(
      'href',
      '/app/projects/proj-1/files?doc=doc-9',
    )
    expect(screen.getByTestId('task-detail-continue-chat')).toHaveAttribute(
      'href',
      '/app/projects/proj-1/chat?session=conv-3',
    )
    // The deep link rides the URL so an inbox knock can land here.
    expect(window.location.search).toContain('task=task-1')
  })

  test('a ?task= deep link opens the detail on mount; closing drops it', async () => {
    tasksPayload = {
      tasks: [row({ filedDocumentId: 'doc-9', conversationId: 'conv-3' })],
    }
    window.history.replaceState(null, '', '/app/projects/proj-1/automation?tab=tasks&task=task-1')
    renderPanel()
    await flush()

    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    expect(screen.getByTestId('task-detail-continue-chat')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(window.location.search).not.toContain('task=')
  })
})
