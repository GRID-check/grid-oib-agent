/**
 * The Tasks panel: fetched on mount, re-asked while visible.
 *
 * A task moves with no socket open in this tab — its worker finishes it, a
 * colleague reviews it — so a fetch-once list would wear a stale "Läuft" until
 * somebody reloaded. The panel polls while visible, parks while hidden, and
 * re-asks on focus. Polls are QUIET: no skeleton and no error state over a list
 * the reader already has.
 *
 * Since the split it loads one thing. The schedules it used to fetch alongside
 * — with their own loading state, their own failure state and a cross-list
 * deep-link settlement — moved to the Zeitplan tab, and the machinery went with
 * them.
 */

import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TASKS_POLL_MS, TasksPanel } from './tasks-panel'
import type { TaskWireRow } from '../lib/task-view'

// The header slot belongs to the section frame; unit tests have none.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => <>{children}</>,
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
  backendJobId: null,
  trigger: 'delegated',
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  ...overrides,
})

let tasks: TaskWireRow[] = []
let taskCalls = 0
let failNext = false

beforeEach(() => {
  tasks = [row()]
  taskCalls = 0
  failNext = false
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
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Let the mount fetch land before asserting on what it produced. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderPanel(props: Partial<React.ComponentProps<typeof TasksPanel>> = {}) {
  const onPromoteToSchedule = vi.fn()
  const utils = render(
    <TasksPanel projectId="proj-1" canManageJobs onPromoteToSchedule={onPromoteToSchedule} {...props} />
  )
  return { ...utils, onPromoteToSchedule }
}

describe('loading the list', () => {
  test('asks once on mount and shows what came back', async () => {
    renderPanel()
    await settle()
    expect(taskCalls).toBe(1)
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
  })

  test('re-asks on the poll cadence while the tab is visible', async () => {
    renderPanel()
    await settle()
    await act(async () => {
      vi.advanceTimersByTime(TASKS_POLL_MS + 10)
      await Promise.resolve()
    })
    expect(taskCalls).toBe(2)
  })

  test('a quiet poll that fails keeps the list the reader already has', async () => {
    renderPanel()
    await settle()
    failNext = true
    await act(async () => {
      vi.advanceTimersByTime(TASKS_POLL_MS + 10)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Aktenvermerk Fluchtwege')).toBeInTheDocument()
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

describe('the drawer and its deep link', () => {
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

describe('promoting a task to a schedule', () => {
  test('hands the draft up to the section, which owns the tab switch', async () => {
    window.history.replaceState(null, '', '/?task=task-1')
    tasks = [row({ goal: 'Prüfe die Fluchtwege jede Woche' })]
    const { onPromoteToSchedule } = renderPanel()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-detail-promote'))
    })
    expect(onPromoteToSchedule).toHaveBeenCalledWith({
      name: 'Aktenvermerk Fluchtwege',
      prompt: 'Prüfe die Fluchtwege jede Woche',
    })
  })
})
