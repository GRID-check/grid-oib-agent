/**
 * The Tasks panel: runs and standing tasks, fetched on mount, re-asked while
 * visible, read as a list or as a week.
 *
 * A task moves with no socket open in this tab — its worker finishes it, a
 * colleague reviews it — so a fetch-once list would wear a stale "Läuft" until
 * somebody reloaded. The panel polls both lists while visible, parks while
 * hidden, and re-asks on focus. Polls are QUIET: no skeleton and no error
 * state over lists the reader already has.
 *
 * Task-first: the runs timeline and the standing arrangements (scheduled or
 * manual) are one tab with two views. `?task=` opens a run drawer,
 * `?schedule=` a standing-task drawer, `?view=` picks list or timetable.
 * Creating opens the wizard in place — a run's "keep as a standing task"
 * lands there pre-filled, with no tab switch in between.
 */

import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Job } from '@/adapters/api/jobs-client'
import { TASKS_POLL_MS, TasksPanel } from './tasks-panel'
import type { TaskWireRow } from '../lib/task-view'

// The header slot belongs to the section frame; unit tests have none.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

// The wizard is a four-step form with its own suite; here it is a door that
// reports what it was opened with and how it was left.
let wizardProps: { job: Job | null; draft: { name: string; prompt: string } | null } | null = null
vi.mock('@/features/jobs/components/schedule-wizard', () => ({
  ScheduleWizard: ({
    job,
    draft,
    onSaved,
    onCancel,
  }: {
    job: Job | null
    draft: { name: string; prompt: string } | null
    onSaved: () => void
    onCancel: () => void
  }) => {
    wizardProps = { job, draft }
    return (
      <div data-testid="schedule-wizard">
        <button type="button" data-testid="wizard-saved" onClick={onSaved}>
          saved
        </button>
        <button type="button" data-testid="wizard-cancelled" onClick={onCancel}>
          cancel
        </button>
      </div>
    )
  },
}))

vi.mock('@/features/jobs/components/schedule-timetable', () => ({
  ScheduleTimetable: ({ onSelect }: { onSelect: (job: Job) => void }) => (
    <div data-testid="schedule-timetable">
      <button
        type="button"
        data-testid="timetable-select"
        onClick={() => onSelect(jobFixture({ id: 'job-1' }))}
      >
        open
      </button>
    </div>
  ),
}))

vi.mock('@/features/jobs/components/schedule-card', () => ({
  ScheduleCard: ({ job, onSelect }: { job: Job; onSelect: (job: Job) => void }) => (
    <button type="button" data-testid="standing-card" onClick={() => onSelect(job)}>
      {job.name}
    </button>
  ),
}))

vi.mock('@/features/jobs/components/schedule-detail', () => ({
  ScheduleDetail: ({
    job,
    open,
    onClose,
  }: {
    job: Job | null
    open: boolean
    onClose: () => void
  }) =>
    open ? (
      <div data-testid="schedule-detail">
        {job?.name}
        <button type="button" data-testid="schedule-detail-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
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
  runMessageId: null,
  backendJobId: null,
  trigger: 'delegated',
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  ...overrides,
})

const jobFixture = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  projectId: 'proj-1',
  name: 'Wöchentlicher Brandschutz-Scan',
  prompt: 'Prüfe die Brandschutzpunkte.',
  skillName: null,
  skillSnapshot: null,
  output: 'chat',
  dataSources: null,
  enabled: true,
  scheduleCron: '0 6 * * 1',
  scheduleTimezone: 'Europe/Vienna',
  dueAt: null,
  nextRunAt: null,
  lastRunAt: null,
  createdBy: 'user_anna',
  createdByEmail: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
})

let tasks: TaskWireRow[] = []
let jobs: Job[] = []
let taskCalls = 0
let jobCalls = 0
let failNext = false
let failJobsNext = false

beforeEach(async () => {
  tasks = [row()]
  jobs = [jobFixture()]
  taskCalls = 0
  jobCalls = 0
  failNext = false
  failJobsNext = false
  wizardProps = null
  window.history.replaceState(null, '', '/')
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/tasks')) {
        taskCalls += 1
        if (failNext) return new Response('nope', { status: 500 })
        return Response.json({ tasks })
      }
      return Response.json({})
    })
  )
  vi.spyOn(await import('@/adapters/api/jobs-client'), 'listJobs').mockImplementation(async () => {
    jobCalls += 1
    if (failJobsNext) throw new Error('jobs down')
    return jobs
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Let the mount fetches land before asserting on what they produced. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderPanel(props: Partial<React.ComponentProps<typeof TasksPanel>> = {}) {
  const utils = render(
    <TasksPanel projectId="proj-1" projectCollection="col-1" canManageJobs {...props} />
  )
  return { ...utils }
}

describe('loading the lists', () => {
  test('asks for runs and standing tasks on mount and shows both', async () => {
    renderPanel()
    await settle()
    expect(taskCalls).toBe(1)
    expect(jobCalls).toBe(1)
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.getByText('Wöchentlicher Brandschutz-Scan')).toBeInTheDocument()
  })

  test('re-asks both on the poll cadence while the tab is visible', async () => {
    renderPanel()
    await settle()
    await act(async () => {
      vi.advanceTimersByTime(TASKS_POLL_MS + 10)
      await Promise.resolve()
    })
    expect(taskCalls).toBe(2)
    expect(jobCalls).toBe(2)
  })

  test('a quiet poll that fails keeps the lists the reader already has', async () => {
    renderPanel()
    await settle()
    failNext = true
    failJobsNext = true
    await act(async () => {
      vi.advanceTimersByTime(TASKS_POLL_MS + 10)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.getByText('Wöchentlicher Brandschutz-Scan')).toBeInTheDocument()
    expect(screen.queryByText('The task list could not be loaded')).not.toBeInTheDocument()
  })

  test('a FIRST load that fails reports, because there is nothing else to show', async () => {
    failNext = true
    renderPanel()
    await settle()
    expect(screen.getByText('The task list could not be loaded')).toBeInTheDocument()
  })

  test('re-asks when the window regains focus', async () => {
    renderPanel()
    await settle()
    await act(async () => {
      fireEvent.focus(window)
      await Promise.resolve()
    })
    expect(taskCalls).toBe(2)
  })
})

describe('the views', () => {
  test('the list is the default view', async () => {
    renderPanel()
    await settle()
    expect(screen.getByTestId('task-list')).toBeInTheDocument()
    expect(screen.queryByTestId('schedule-timetable')).not.toBeInTheDocument()
  })

  test('the toggle switches to the timetable and writes `?view=`', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    renderPanel()
    await settle()
    await user.click(screen.getByTestId('tasks-view-timetable'))
    expect(screen.getByTestId('schedule-timetable')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('view')).toBe('timetable')
  })

  test('`?view=timetable` opens the timetable directly', async () => {
    window.history.replaceState(null, '', '/?view=timetable')
    renderPanel()
    await settle()
    expect(screen.getByTestId('schedule-timetable')).toBeInTheDocument()
  })

  test('initialView opens the timetable without a view param', async () => {
    renderPanel({ initialView: 'timetable' })
    await settle()
    expect(screen.getByTestId('schedule-timetable')).toBeInTheDocument()
  })
})

describe('the run drawer and its deep link', () => {
  test('a `?task=` on the URL opens that task', async () => {
    window.history.replaceState(null, '', '/?task=task-1')
    renderPanel()
    await settle()
    const detail = screen.getByTestId('task-detail')
    expect(detail).toBeInTheDocument()
    // The drawer resolves the id against the live list rather than holding a
    // copy, so the title inside it is the list's row.
    expect(within(detail).getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
  })

  test('opening a card puts it on the URL, so the view is shareable', async () => {
    renderPanel()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-card'))
    })
    expect(new URL(window.location.href).searchParams.get('task')).toBe('task-1')
  })

  test('closing takes it back off', async () => {
    window.history.replaceState(null, '', '/?task=task-1')
    renderPanel()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    })
    expect(new URL(window.location.href).searchParams.get('task')).toBeNull()
  })

  test('a link naming no row here says "not here", not "deleted"', async () => {
    window.history.replaceState(null, '', '/?task=elsewhere')
    renderPanel()
    await settle()
    expect(screen.getByText(/could not be found here/i)).toBeInTheDocument()
  })
})

describe('the standing-task drawer and its deep link', () => {
  test('a `?schedule=` on the URL opens that standing task', async () => {
    window.history.replaceState(null, '', '/?schedule=job-1')
    renderPanel()
    await settle()
    expect(screen.getByTestId('schedule-detail')).toBeInTheDocument()
  })

  test('opening a standing card puts it on the URL', async () => {
    renderPanel()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('standing-card')[0])
    })
    expect(new URL(window.location.href).searchParams.get('schedule')).toBe('job-1')
  })
})

describe('creating a task', () => {
  test('the one create button opens the wizard in place', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    renderPanel()
    await settle()
    await user.click(screen.getByTestId('tasks-new'))
    expect(screen.getByTestId('schedule-wizard')).toBeInTheDocument()
    expect(wizardProps).toEqual({ job: null, draft: null })
  })

  test('cancelling the wizard returns to the list', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    renderPanel()
    await settle()
    await user.click(screen.getByTestId('tasks-new'))
    await user.click(screen.getByTestId('wizard-cancelled'))
    expect(screen.queryByTestId('schedule-wizard')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-list')).toBeInTheDocument()
  })

  test('promoting a run opens the wizard with the draft pre-filled', async () => {
    window.history.replaceState(null, '', '/?task=task-1')
    tasks = [row({ goal: 'Prüfe die Fluchtwege jede Woche' })]
    renderPanel()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-detail-promote'))
    })
    expect(screen.getByTestId('schedule-wizard')).toBeInTheDocument()
    expect(wizardProps?.draft).toEqual({
      name: 'Aktenvermerk Fluchtwege',
      prompt: 'Prüfe die Fluchtwege jede Woche',
    })
  })
})

describe('delegating', () => {
  test('links into the project chat, where one-shot delegation happens', async () => {
    renderPanel()
    await settle()
    expect(screen.getByTestId('tasks-delegate').closest('a')).toHaveAttribute(
      'href',
      '/app/projects/proj-1/chat'
    )
  })

  test('is disabled — with the composer’s own reason — without `project:chat`', async () => {
    renderPanel({ canChatInProject: false })
    await settle()
    expect(screen.getByTestId('tasks-delegate')).toBeDisabled()
  })
})
