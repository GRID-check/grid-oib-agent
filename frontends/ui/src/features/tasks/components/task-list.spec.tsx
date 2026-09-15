/**
 * The Tasks list — cards, filters and recency groups.
 *
 * What is asserted is what one CARD has to answer, because that is the whole
 * reason the surface exists: a person delegated work in a chat and had nowhere
 * to ask what became of it. What it is, where it got to, how it was judged, and
 * WHERE THE RESULT IS. Plus the two things the rewrite added and the old row
 * could not do — that the whole card is the target, and that a finished task
 * nobody has judged is visibly an open loop.
 */

import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TaskList } from './task-list'
import type { TaskFilter, TaskWireRow } from '../lib/task-view'

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
  backendJobId: null,
  trigger: 'delegated',
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  ...overrides,
})

function list(props: Partial<React.ComponentProps<typeof TaskList>> = {}) {
  const onFilterChange = vi.fn()
  const onSelectTask = vi.fn()
  const utils = render(
    <TaskList
      projectId="p1"
      tasks={[task()]}
      filter={'all' as TaskFilter}
      onFilterChange={onFilterChange}
      onSelectTask={onSelectTask}
      {...props}
    />,
  )
  return { ...utils, onFilterChange, onSelectTask }
}

describe('a task card', () => {
  test('says what was asked for, what kind of work it is, and where it got to', () => {
    list({ tasks: [task({ status: 'running' })] })
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.getByText('Fasse die Fluchtweglängen für die Einreichung zusammen')).toBeInTheDocument()
    expect(screen.getByTestId('task-kind')).toHaveTextContent('Document')
    expect(screen.getByTestId('task-status')).toHaveTextContent('Running')
  })

  test('the WHOLE card opens the detail, not a hover-underlined title', async () => {
    const user = userEvent.setup()
    const { onSelectTask } = list()
    await user.click(screen.getByTestId('task-card'))
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }))
  })

  test('and it opens from the keyboard, because a div that acts as a button must', async () => {
    const user = userEvent.setup()
    const { onSelectTask } = list()
    // The filter row comes first in the tab order, so the card is focused
    // directly — what is under test is that a focused card answers Enter, not
    // where it sits in the sequence.
    screen.getByTestId('task-card').focus()
    await user.keyboard('{Enter}')
    expect(onSelectTask).toHaveBeenCalled()
  })

  test('links straight to the result — the reason somebody opened the list', () => {
    list({ tasks: [task({ filedDocumentId: 'doc-9' })] })
    expect(screen.getByTestId('task-card-result')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-9',
    )
  })

  test('following the result does NOT also open the drawer behind it', async () => {
    const user = userEvent.setup()
    const { onSelectTask } = list({ tasks: [task({ filedDocumentId: 'doc-9' })] })
    await user.click(screen.getByTestId('task-card-result'))
    expect(onSelectTask).not.toHaveBeenCalled()
  })

  test('a finished task nobody judged is marked — that is the open loop', () => {
    list({ tasks: [task({ status: 'succeeded', review: null })] })
    expect(screen.getByTestId('task-card-unreviewed')).toBeInTheDocument()
  })

  test('…and the mark goes once somebody has judged it', () => {
    list({ tasks: [task({ status: 'succeeded', review: 'accepted' })] })
    expect(screen.queryByTestId('task-card-unreviewed')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-review')).toHaveTextContent('Accepted')
  })

  test('a rejection carries the reviewer’s own words, never a paraphrase', () => {
    list({
      tasks: [
        task({
          review: 'rejected',
          reviewReason: 'Die Barrierefreiheit fehlt — bitte mit OIB 4 gegenprüfen.',
        }),
      ],
    })
    expect(screen.getByTestId('task-review-reason')).toHaveTextContent('bitte mit OIB 4')
  })

  test('a failure says why, both when the run broke and when the submission did', () => {
    for (const status of ['failed', 'error'] as const) {
      const { unmount } = list({ tasks: [task({ status, error: 'Budget aufgebraucht.' })] })
      expect(screen.getByTestId('task-error')).toHaveTextContent('Budget aufgebraucht.')
      unmount()
    }
  })
})

describe('the filter row', () => {
  const mixed = [
    task({ id: 'a', status: 'running' }),
    task({ id: 'b', status: 'succeeded', review: null }),
    task({ id: 'c', status: 'succeeded', review: 'accepted' }),
    task({ id: 'd', status: 'failed', error: 'kaputt' }),
  ]

  test('carries the counts, so a filter is never a click to learn nothing', () => {
    list({ tasks: mixed })
    expect(within(screen.getByTestId('task-filter-all')).getByText('4')).toBeInTheDocument()
    expect(within(screen.getByTestId('task-filter-active')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTestId('task-filter-unreviewed')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTestId('task-filter-failed')).getByText('1')).toBeInTheDocument()
  })

  test('narrows the list to what it names', () => {
    list({ tasks: mixed, filter: 'failed' })
    expect(screen.getAllByTestId('task-card')).toHaveLength(1)
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
    expect(screen.getByTestId('task-error')).toBeInTheDocument()
  })

  test('reports the pick rather than owning it — the panel holds the filter', async () => {
    const user = userEvent.setup()
    const { onFilterChange } = list({ tasks: mixed })
    await user.click(screen.getByTestId('task-filter-unreviewed'))
    expect(onFilterChange).toHaveBeenCalledWith('unreviewed')
  })

  test('an empty NARROWED list says so, and offers the way back', async () => {
    const user = userEvent.setup()
    const { onFilterChange } = list({ tasks: [task({ status: 'succeeded', review: 'accepted' })], filter: 'failed' })
    expect(screen.getByText('Nothing has failed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all tasks' }))
    expect(onFilterChange).toHaveBeenCalledWith('all')
  })
})

describe('the shape of a long list', () => {
  test('groups by recency, newest group first', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const older = new Date()
    older.setDate(older.getDate() - 20)

    list({
      tasks: [
        task({ id: 'a', createdAt: new Date().toISOString() }),
        task({ id: 'b', createdAt: yesterday.toISOString() }),
        task({ id: 'c', createdAt: older.toISOString() }),
      ],
    })
    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headings).toEqual(['Today', 'Yesterday', 'Earlier'])
  })
})

describe('the three states that are not a list', () => {
  test('nothing yet reads as an invitation', () => {
    list({ tasks: [] })
    expect(screen.getByText('Nothing delegated yet')).toBeInTheDocument()
  })

  test('a failed load says the rest of the project is fine, and offers a retry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    list({ tasks: [], failed: true, onRetry })
    expect(screen.getByText('The task list could not be loaded')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })

  test('loading is a skeleton, never an empty state that claims there is nothing', () => {
    list({ tasks: [], loading: true })
    expect(screen.getByTestId('task-list-loading')).toBeInTheDocument()
    expect(screen.queryByText('Nothing delegated yet')).not.toBeInTheDocument()
  })
})
