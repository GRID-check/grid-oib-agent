/**
 * The Aufgabe detail drawer: one run's result, or one schedule's runs.
 *
 * Two shapes like the list. An instance homes its result — the filed document
 * first, the conversation to continue second — and never a chat history. A
 * template shows its schedule, the prompt it fires, and the moved (not
 * rewritten) run history with a retry-with-the-same-plan.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { Job } from '@/adapters/api/jobs-client'
import { TaskDetail } from './task-detail'
import type { TaskWireRow } from '../lib/task-view'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/features/jobs/components/job-run-history', () => ({
  JobRunHistory: ({ jobId }: { jobId: string }) => (
    <div data-testid="job-run-history-stub" data-job-id={jobId} />
  ),
}))

// In-app doc/chat links must stay client-side: a plain `<a>` would reload the
// whole shell, dropping the drawer state the deep link just opened.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} data-next-link="true" {...rest}>
      {children}
    </a>
  ),
}))

import { toast } from 'sonner'

const task = (overrides: Partial<TaskWireRow> = {}): TaskWireRow => ({
  id: 'task-1',
  kind: 'deep-research',
  title: 'OIB-Brandschutzbericht',
  goal: 'Prüfe die Fluchtweglängen',
  status: 'succeeded',
  review: null,
  reviewReason: null,
  filedDocumentId: 'doc-9',
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
  projectCollection: 'col-1',
  canManageJobs: true,
  onJobChanged: () => {},
  onClose: () => {},
} as const

describe('TaskDetail instances', () => {
  test('stays shut without a selection', () => {
    render(<TaskDetail {...baseProps} selection={null} task={null} job={null} />)
    expect(screen.queryByTestId('task-detail')).toBeNull()
  })

  test('says the row is gone instead of showing a stale snapshot', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'task', id: 'task-1' }}
        task={null}
        job={null}
      />,
    )
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    // The title names the absence — never the close label over gone content.
    expect(screen.getByText('Not found')).toBeInTheDocument()
    expect(screen.getByText(/This no longer exists/)).toBeInTheDocument()
  })

  test('a deep link that never matched reads as "not here", not as "gone"', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'task', id: 'task-foreign' }}
        task={null}
        job={null}
        goneReason="unresolved"
      />,
    )
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    // The title is shared; the body must not claim a departure it never saw.
    expect(screen.getByText('Not found')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This could not be found here. The link may point to another project, or the item was deleted.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/This no longer exists/)).toBeNull()
  })

  test('an unchecked deep link waits instead of claiming anything', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'task', id: 'task-1' }}
        task={null}
        job={null}
        goneReason="unresolved"
        resolving
      />,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    // The heading waits too: „Not found" over a pending read is a finding the
    // drawer has not earned yet.
    expect(screen.queryByText('Not found')).toBeNull()
    expect(screen.queryByText(/This no longer exists/)).toBeNull()
    expect(screen.queryByText(/could not be found here/)).toBeNull()
  })

  test('homes a deep-research result in the filed document', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'task', id: 'task-1' }}
        task={task()}
        job={null}
      />,
    )

    expect(screen.getByTestId('task-detail-result-doc')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-9',
    )
    // Client-side navigation — a plain `<a>` would reload the shell.
    expect(screen.getByTestId('task-detail-result-doc')).toHaveAttribute('data-next-link', 'true')
    expect(screen.getByTestId('task-detail-goal')).toHaveTextContent('Prüfe die Fluchtweglängen')
    // No chat run, no continue link — and no history link anywhere.
    expect(screen.queryByTestId('task-detail-continue-chat')).toBeNull()
  })

  test('a chat run carries the rehydration link', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'task', id: 'task-1' }}
        task={task({ kind: 'chat', filedDocumentId: null, conversationId: 'conv-3' })}
        job={null}
      />,
    )
    const link = screen.getByTestId('task-detail-continue-chat')
    expect(link).toHaveAttribute('href', '/app/projects/p1/chat?session=conv-3')
    expect(link).toHaveAttribute('data-next-link', 'true')
    expect(link).toHaveTextContent('Continue in chat')
  })

  test('an unfinished run shows no result section yet', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'task', id: 'task-1' }}
        task={task({ status: 'running', filedDocumentId: null })}
        job={null}
      />,
    )
    expect(screen.queryByTestId('task-detail-result-doc')).toBeNull()
    expect(screen.queryByText('Result')).toBeNull()
  })
})

describe('TaskDetail templates', () => {
  test('shows the schedule, the prompt it fires, and its runs', () => {
    render(
      <TaskDetail
        {...baseProps}
        selection={{ kind: 'job', id: 'job-1' }}
        task={null}
        job={job()}
      />,
    )

    expect(screen.getByTestId('task-detail-schedule')).toHaveTextContent(
      'Weekly on Monday at 06:00 · Europe/Vienna',
    )
    expect(screen.getByTestId('task-detail-prompt')).toHaveTextContent(
      'Prüfe die Brandschutzpunkte.',
    )
    expect(screen.getByTestId('job-run-history-stub')).toHaveAttribute('data-job-id', 'job-1')
  })

  test('retry fires the same plan again and reveals the new run', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'submitted', jobId: 'job-9' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const onJobChanged = vi.fn()
      render(
        <TaskDetail
          {...baseProps}
          selection={{ kind: 'job', id: 'job-1' }}
          task={null}
          job={job()}
          onJobChanged={onJobChanged}
        />,
      )

      fireEvent.click(screen.getByTestId('task-detail-run-now'))

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/projects/p1/jobs/job-1/run',
          expect.objectContaining({ method: 'POST' }),
        ),
      )
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        'Run started.',
        expect.objectContaining({ description: expect.any(String) }),
      )
      expect(onJobChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1', lastRunAt: expect.any(String) }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a 409 on retry marks the stale-enabled row paused immediately', async () => {
    vi.mocked(toast.error).mockClear()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'Job is disabled', code: 'CONFLICT' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const onJobChanged = vi.fn()
      const { rerender } = render(
        <TaskDetail
          {...baseProps}
          selection={{ kind: 'job', id: 'job-1' }}
          task={null}
          job={job()}
          onJobChanged={onJobChanged}
        />,
      )

      fireEvent.click(screen.getByTestId('task-detail-run-now'))

      await waitFor(() => {
        expect(onJobChanged).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'job-1', enabled: false }),
        )
      })
      // The 409 handling stays: the reader is told to enable first.
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Enable the job before running it.')

      // The paused state renders from the row — the same object the list reads.
      rerender(
        <TaskDetail
          {...baseProps}
          selection={{ kind: 'job', id: 'job-1' }}
          task={null}
          job={job({ enabled: false })}
          onJobChanged={onJobChanged}
        />,
      )
      expect(screen.getByText('Disabled')).toBeInTheDocument()
      expect(screen.getByTestId('task-detail-run-now')).toBeDisabled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('read-only without project:skills:manage — no switch, no retry', () => {
    render(
      <TaskDetail
        {...baseProps}
        canManageJobs={false}
        selection={{ kind: 'job', id: 'job-1' }}
        task={null}
        job={job()}
      />,
    )
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByTestId('task-detail-run-now')).toBeNull()
    expect(screen.queryByTestId('task-detail-edit')).toBeNull()
    expect(screen.getByTestId('job-run-history-stub')).toBeInTheDocument()
  })

  test('a manageable definition opens the builder from the drawer', () => {
    // The retired Jobs panel carried this edit button; without it a schedule
    // could be created and never changed.
    const onEditJob = vi.fn()
    render(
      <TaskDetail
        {...baseProps}
        onEditJob={onEditJob}
        selection={{ kind: 'job', id: 'job-1' }}
        task={null}
        job={job()}
      />,
    )
    fireEvent.click(screen.getByTestId('task-detail-edit'))
    expect(onEditJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }))
  })
})
