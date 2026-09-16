/**
 * The task drawer — the result, and the one way a task becomes a schedule.
 *
 * Two claims carry the file. The first is that the drawer always points at
 * SOMEWHERE: whichever of document, conversation, report or thinking this task
 * actually has, it offers exactly one primary destination, and only a task that
 * genuinely has none shows nothing. The second is „Als Zeitplan speichern",
 * which is offered on work a person wrote and withheld on work a schedule
 * already produces — otherwise it proposes duplicating the schedule that fired
 * it.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TaskDetail } from './task-detail'
import type { TaskWireRow } from '../lib/task-view'

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
