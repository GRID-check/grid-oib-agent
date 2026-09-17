/**
 * The task drawer — the account of the run, the result, and the one way a task
 * becomes a schedule.
 *
 * Three claims carry the file. The first is the one this drawer exists for:
 * a task with a run shows the REAL block, off the run's own ledger, rather
 * than a second description of the run assembled from the row — and a task
 * WITHOUT one falls back to exactly the paragraphs the drawer used to show,
 * because for a legacy run those are the only account there is. The second is
 * that the drawer always points at SOMEWHERE: whichever of document,
 * conversation, report or thinking this task actually has. The third is „Als
 * Zeitplan speichern", offered on work a person wrote and withheld on work a
 * schedule already produces.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { RUN_FERTIG } from '@/app/dev/_fixtures/run-ledgers'
import { TaskDetail } from './task-detail'
import type { TaskWireRow } from '../lib/task-view'

const fetchRunView = vi.hoisted(() => vi.fn())
vi.mock('@/lib/runs/run-view-client', () => ({
  fetchRunView,
  RunViewError: class RunViewError extends Error {},
}))

beforeEach(() => {
  fetchRunView.mockReset()
  fetchRunView.mockResolvedValue({
    runId: 'task-1',
    backendJobId: null,
    conversationId: 'conv-1',
    messageId: 'msg-1',
    status: 'succeeded',
    ledger: RUN_FERTIG,
  })
})

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
  runMessageId: null,
  backendJobId: null,
  trigger: 'delegated',
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: '2026-09-15T08:00:00.000Z',
  finishedAt: null,
  error: null,
  ...overrides,
})

function drawer(props: Partial<React.ComponentProps<typeof TaskDetail>> = {}) {
  const onPromoteToTask = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <TaskDetail
      projectId="p1"
      task={task()}
      open
      canManageJobs
      onPromoteToTask={onPromoteToTask}
      onClose={onClose}
      {...props}
    />,
  )
  return { ...utils, onPromoteToTask, onClose }
}

describe('what the drawer says a task became', () => {
  test('a filed result opens the document', () => {
    drawer({ task: task({ filedDocumentId: 'doc-9' }) })
    expect(screen.getByTestId('task-detail-result')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-9',
    )
  })

  test('a research run that filed nothing still opens its report', () => {
    drawer({ task: task({ kind: 'deep-research', backendJobId: 'bj-1' }) })
    expect(screen.getByTestId('task-detail-result')).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?job=bj-1',
    )
  })

  test('a task with nowhere to point offers nothing rather than a dead link', () => {
    drawer({ task: task({ status: 'error', error: 'Übermittlung gebrochen.' }) })
    expect(screen.queryByTestId('task-detail-result')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-detail-error')).toBeInTheDocument()
  })

  test('the requester’s own sentence is shown, never the compiled prompt', () => {
    drawer()
    expect(screen.getByTestId('task-detail-goal')).toHaveTextContent('Fluchtweglängen')
  })
})

describe('turning a task into a schedule', () => {
  test('hands over the title and the request, and nothing else', async () => {
    const user = userEvent.setup()
    const { onPromoteToTask } = drawer()
    await user.click(screen.getByTestId('task-detail-promote'))
    expect(onPromoteToTask).toHaveBeenCalledWith({
      name: 'Aktenvermerk Fluchtwege',
      prompt: 'Fasse die Fluchtweglängen für die Einreichung zusammen',
    })
  })

  test('is withheld on a scheduled run — it already recurs', () => {
    drawer({ task: task({ trigger: 'schedule' }) })
    expect(screen.queryByTestId('task-detail-promote')).not.toBeInTheDocument()
  })

  test('is withheld without the permission the server enforces', () => {
    drawer({ canManageJobs: false })
    expect(screen.queryByTestId('task-detail-promote')).not.toBeInTheDocument()
  })

  test('is withheld when there is no sentence to carry over', () => {
    drawer({ task: task({ goal: null }) })
    expect(screen.queryByTestId('task-detail-promote')).not.toBeInTheDocument()
  })
})

describe('a selection that resolves to nothing', () => {
  test('waits while the deep link is still being checked — no finding yet', () => {
    drawer({ task: null, resolving: true })
    expect(screen.getByText('Loading')).toBeInTheDocument()
    expect(screen.queryByText('Not found')).not.toBeInTheDocument()
  })

  test('a row the drawer SAW leave reads as deleted', () => {
    drawer({ task: null, goneReason: 'deleted' })
    expect(screen.getByText(/no longer exists/i)).toBeInTheDocument()
  })

  test('a link that never matched reads as "not here", which is a weaker claim', () => {
    drawer({ task: null, goneReason: 'unresolved' })
    expect(screen.getByText(/could not be found here/i)).toBeInTheDocument()
  })
})

describe('the run itself, which is what the drawer is for', () => {
  const withRun = task({ conversationId: 'conv-1', runMessageId: 'msg-1' })

  test('renders the block off the run’s own ledger, not a retelling of the row', async () => {
    drawer({ task: withRun })
    expect(await screen.findByTestId('run-stand')).toBeInTheDocument()
    expect(fetchRunView).toHaveBeenCalledWith('p1', 'task-1')
    // The row's paragraphs are the block's job now: the title is the ask, the
    // status line is the outcome. Repeating them beside it is the lookalike.
    expect(screen.queryByTestId('task-detail-goal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-status')).not.toBeInTheDocument()
  })

  test('opens the block rather than making the reader unfold it again', async () => {
    drawer({ task: withRun })
    await screen.findByTestId('run-stand')
    // Terminal runs collapse by default in a thread, where the reader is
    // scrolling past them. Clicking the row IS the request to see inside.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Aktenvermerk Fluchtwege/ })).toHaveAttribute(
        'data-state',
        'open',
      ),
    )
  })

  test('keeps a way into the thread beside the result — reading is not following', async () => {
    drawer({ task: task({ conversationId: 'conv-1', runMessageId: 'msg-1', filedDocumentId: 'doc-9' }) })
    await screen.findByTestId('run-stand')
    expect(screen.getByTestId('task-detail-result')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-9',
    )
    expect(screen.getByTestId('task-detail-thread')).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?session=conv-1&run=task-1#message-msg-1',
    )
  })

  test('drops the thread link when the result already IS the thread', async () => {
    drawer({ task: withRun })
    await screen.findByTestId('run-stand')
    expect(screen.getByTestId('task-detail-result')).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?session=conv-1&run=task-1#message-msg-1',
    )
    expect(screen.queryByTestId('task-detail-thread')).not.toBeInTheDocument()
  })

  test('a refused read says so, and still offers the result', async () => {
    fetchRunView.mockRejectedValue(new Error('403'))
    drawer({ task: withRun })
    expect(await screen.findByTestId('task-detail-run-failed')).toBeInTheDocument()
    expect(screen.getByTestId('task-detail-result')).toBeInTheDocument()
  })

  test('a run from before run messages is never fetched, and keeps its paragraphs', () => {
    drawer()
    expect(fetchRunView).not.toHaveBeenCalled()
    expect(screen.getByTestId('task-detail-goal')).toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-run-failed')).not.toBeInTheDocument()
  })
})
