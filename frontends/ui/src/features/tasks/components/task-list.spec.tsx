/**
 * The Aufgaben list (ADR-0051, and the review that found it missing).
 *
 * What is asserted is what one ROW has to answer, because that is the whole
 * reason the surface exists: a person delegated work in a chat and had nowhere
 * to ask what became of it. Kind, what was asked for, where it got to, how it
 * was judged, and WHERE THE RESULT IS — plus, for a schedule, WHEN it fires
 * next and whether it is paused. Templates and instances are two shapes, so
 * they are asserted as two shapes.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { Job } from '@/adapters/api/jobs-client'
import { TaskList } from './task-list'
import type { TaskWireRow } from '../lib/task-view'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

const task = (overrides: Partial<TaskWireRow> = {}): TaskWireRow => ({
  id: 'task-1',
  kind: 'document',
  title: 'Aktenvermerk Fluchtwege',
  goal: 'Fasse die Fluchtweglängen für die Einreichung zusammen',
  status: 'succeeded',
  review: null,
  reviewReason: null,
  filedDocumentId: null,
  conversationId: null,
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: '2026-09-01T10:00:00.000Z',
  finishedAt: '2026-09-01T10:04:00.000Z',
  error: null,
  ...overrides,
})

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  projectId: 'p1',
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
  ...overrides,
})

const baseProps = {
  projectId: 'p1',
  tasks: [task()],
  jobs: [],
} as const

describe('TaskList instances', () => {
  test('says what was delegated, what kind of work it is, and where it got to', () => {
    render(<TaskList {...baseProps} />)

    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.getByTestId('task-kind')).toHaveTextContent('Document')
    expect(screen.getByTestId('task-status')).toHaveTextContent('Done')
    expect(
      screen.getByText('Fasse die Fluchtweglängen für die Einreichung zusammen'),
    ).toBeInTheDocument()
  })

  test('instances carry no cadence chip — cadence lives on templates alone', () => {
    render(<TaskList {...baseProps} />)
    expect(screen.queryByTestId('task-cadence')).toBeNull()
  })

  test('links to the document the result was filed as, in the project files', () => {
    // The one thing a list of finished work has to answer. The row links there
    // rather than summarising the report, which is what the document is for.
    render(<TaskList projectId="p1" tasks={[task({ filedDocumentId: 'doc-9' })]} jobs={[]} />)
    expect(screen.getByTestId('task-document-link')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-9',
    )
  })

  test('a chat run carries the rehydration link, never a history link', () => {
    // "Im Chat fortsetzen" reopens the thread so it can be continued — the
    // outcome is not linked into a chat history from here.
    render(<TaskList projectId="p1" tasks={[task({ kind: 'chat', conversationId: 'conv-3' })]} jobs={[]} />)
    const link = screen.getByTestId('task-conversation-link')
    expect(link).toHaveAttribute('href', '/app/projects/p1/chat?session=conv-3')
    expect(link).toHaveTextContent('Continue in chat')
  })

  test('carries the reviewer’s own words when the work was sent back', () => {
    // Verbatim: the next run reads exactly this string, and a paraphrase would
    // be an objection somebody else made.
    render(
      <TaskList
        projectId="p1"
        tasks={[
          task({ review: 'rejected', reviewReason: 'Die Fluchtweglänge stimmt nicht' }),
        ]}
        jobs={[]}
      />,
    )
    expect(screen.getByTestId('task-review')).toHaveTextContent('Sent back')
    expect(screen.getByTestId('task-review-reason')).toHaveTextContent(
      'Die Fluchtweglänge stimmt nicht',
    )
  })

  test('shows the worker’s sanitized error on a failure', () => {
    render(
      <TaskList
        projectId="p1"
        tasks={[task({ status: 'failed', error: 'Das Budget war aufgebraucht.' })]}
        jobs={[]}
      />,
    )
    expect(screen.getByTestId('task-error')).toHaveTextContent('Das Budget war aufgebraucht.')
    expect(screen.getByTestId('task-error')).toHaveClass('text-error')
  })

  test('names who asked, so a shared project’s list is legible', () => {
    render(<TaskList {...baseProps} />)
    expect(screen.getByText(/Anna Berger/)).toBeInTheDocument()
  })

  test('selecting a row opens its detail rather than navigating away', () => {
    const onSelectTask = vi.fn()
    render(<TaskList {...baseProps} onSelectTask={onSelectTask} />)
    fireEvent.click(screen.getByTestId('task-title'))
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }))
  })

  test('shows an invitation rather than an empty box', () => {
    render(<TaskList projectId="p1" tasks={[]} jobs={[]} />)
    expect(screen.getByText('Nothing delegated yet')).toBeInTheDocument()
    expect(screen.queryByTestId('task-row')).toBeNull()
  })

  test('says the listing failed rather than claiming there is no work', () => {
    // „Noch nichts übergeben" over a failed request is the one lie this surface
    // could tell that a person would act on.
    render(<TaskList projectId="p1" tasks={[]} jobs={[]} failed />)
    expect(screen.getByText('The task list could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('Nothing delegated yet')).toBeNull()
  })

  test('shows a skeleton while it is loading, not the empty state', () => {
    render(<TaskList projectId="p1" tasks={[]} jobs={[]} loading />)
    expect(screen.getByTestId('task-list-loading')).toBeInTheDocument()
    expect(screen.queryByText('Nothing delegated yet')).toBeNull()
  })
})

describe('TaskList templates', () => {
  test('a template row names its cadence and its next fire, not a status', () => {
    render(<TaskList projectId="p1" tasks={[]} jobs={[job()]} />)

    expect(screen.getByTestId('template-row')).toBeInTheDocument()
    expect(screen.getByTestId('template-cadence')).toHaveTextContent(
      'Weekly on Monday at 06:00 · Europe/Vienna',
    )
    expect(screen.getByTestId('template-next')).toHaveTextContent(/Next/)
    // A schedule is not work: it carries no planner status and no review.
    expect(screen.queryByTestId('task-status')).toBeNull()
    expect(screen.queryByTestId('task-review')).toBeNull()
  })

  test('template rows carry no decorative side border — the section groups them', () => {
    render(<TaskList projectId="p1" tasks={[]} jobs={[job()]} />)
    const row = screen.getByTestId('template-row')
    expect(row).not.toHaveClass('border-l-4')
    expect(row).not.toHaveClass('border-l-info')
  })

  test('a manual-only job is no template — it stays on the Jobs tab', () => {
    render(
      <TaskList projectId="p1" tasks={[]} jobs={[job({ id: 'j-man', scheduleCron: null })]} />,
    )
    expect(screen.queryByTestId('template-row')).toBeNull()
    expect(screen.getByText(/No recurring schedules/)).toBeInTheDocument()
  })

  test('pausing a schedule toggles it optimistically', async () => {
    const updated = job({ enabled: false })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => updated })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const onJobChanged = vi.fn()
      render(
        <TaskList
          projectId="p1"
          tasks={[]}
          jobs={[job()]}
          canManageJobs
          onJobChanged={onJobChanged}
        />,
      )

      fireEvent.click(await screen.findByRole('switch'))

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/projects/p1/jobs/job-1',
          expect.objectContaining({ method: 'PATCH' }),
        ),
      )
      expect(onJobChanged).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('read-only without project:skills:manage — no switch to pause with', () => {
    render(<TaskList projectId="p1" tasks={[]} jobs={[job()]} canManageJobs={false} />)
    expect(screen.getByTestId('template-row')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  test('selecting a template opens its detail', () => {
    const onSelectJob = vi.fn()
    render(<TaskList projectId="p1" tasks={[]} jobs={[job()]} onSelectJob={onSelectJob} />)
    fireEvent.click(screen.getByTestId('template-title'))
    expect(onSelectJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }))
  })

  test('no submission words reach either shape', () => {
    // Statuses are planner words on rows; `submitted`/`pending` are folded at
    // the panel boundary (see tasks-panel.spec), so neither shape may render
    // them — and templates render no status at all.
    render(<TaskList projectId="p1" tasks={[task({ status: 'queued' })]} jobs={[job()]} />)
    expect(screen.queryByText('Submitted')).toBeNull()
    expect(screen.queryByText('Pending')).toBeNull()
    expect(screen.queryByText('submitted')).toBeNull()
    expect(screen.queryByText('pending')).toBeNull()
  })
})
