import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AutomationPanel } from './automation-panel'
import { parseAutomationTab } from '../lib/automation-tab'

// The tabs' JOIN is what this file pins: which panel is mounted, when. The
// panels themselves have their own specs.
vi.mock('@/features/jobs/components/jobs-panel', () => ({
  JobsPanel: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="jobs-panel" data-can-manage={canManage} />
  ),
}))
vi.mock('@/features/skills/components/skills-panel', () => ({
  SkillsPanel: ({ canManageOrgSkills }: { canManageOrgSkills: boolean }) => (
    <div data-testid="skills-panel" data-can-manage={canManageOrgSkills} />
  ),
}))
vi.mock('@/features/tasks/components/tasks-panel', () => ({
  TasksPanel: ({
    canManageJobs,
    canChatInProject = true,
  }: {
    canManageJobs: boolean
    canChatInProject?: boolean
  }) => (
    <div
      data-testid="tasks-panel"
      data-can-manage={canManageJobs}
      data-can-chat={canChatInProject}
    />
  ),
}))

const baseProps = {
  projectId: 'p1',
  projectCollection: 'col-1',
  canManageOrgSkills: true,
  canManageJobs: false,
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('parseAutomationTab', () => {
  test('tasks is the default for anything that is not a tab', () => {
    expect(parseAutomationTab(undefined)).toBe('tasks')
    expect(parseAutomationTab('nonsense')).toBe('tasks')
    expect(parseAutomationTab('skills')).toBe('skills')
  })

  test('?tab=jobs keeps landing on the schedules view', () => {
    // The id is the alias: bookmarks, inbox rows and old links must not rot
    // now that Aufgaben leads.
    expect(parseAutomationTab('jobs')).toBe('jobs')
  })
})

describe('AutomationPanel — one mounted tab at a time', () => {
  test('Aufgaben leads: the default tab is mounted without a ?tab=', () => {
    render(<AutomationPanel {...baseProps} initialTab={parseAutomationTab(undefined)} />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('jobs-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
  })

  test('mounts ONLY the active tab', () => {
    // Load-bearing, not an optimization: both panels portal their primary
    // action into the section header's single slot — two mounted panels would
    // fight over it.
    render(<AutomationPanel {...baseProps} initialTab="jobs" />)
    expect(screen.getByTestId('jobs-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
  })

  test('honours the deep-linked tab', () => {
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('jobs-panel')).not.toBeInTheDocument()
  })

  test('switching swaps the mounted panel and writes ?tab= for sharing', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} initialTab="jobs" />)

    await user.click(screen.getByRole('tab', { name: 'Skills' }))

    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('jobs-panel')).not.toBeInTheDocument()
    expect(window.location.search).toBe('?tab=skills')
  })

  test('switching tabs preserves drawer deep links instead of wiping them', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=tasks&task=task-1')
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)

    await user.click(screen.getByRole('tab', { name: 'Jobs' }))

    expect(screen.getByTestId('jobs-panel')).toBeInTheDocument()
    const params = new URL(window.location.href).searchParams
    expect(params.get('tab')).toBe('jobs')
    expect(params.get('task')).toBe('task-1')
  })

  test('a ?tab=jobs&task= knock opens the task and corrects ?tab=', () => {
    // The drawer lives on Aufgaben: the deep link wins over the tab, and the
    // URL is corrected so closing the drawer (or copying the link) stays on
    // the tab that is showing.
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=jobs&task=task-1')
    render(<AutomationPanel {...baseProps} initialTab="jobs" />)

    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('jobs-panel')).not.toBeInTheDocument()
    const params = new URL(window.location.href).searchParams
    expect(params.get('tab')).toBe('tasks')
    expect(params.get('task')).toBe('task-1')
  })

  test('a ?tab=skills&schedule= knock opens the schedule on Aufgaben', () => {
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=skills&schedule=job-1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)

    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    const params = new URL(window.location.href).searchParams
    expect(params.get('tab')).toBe('tasks')
    expect(params.get('schedule')).toBe('job-1')
  })

  test('hands each panel its own authorization, not a shared one', () => {
    render(<AutomationPanel {...baseProps} initialTab="jobs" />)
    // Org-skills manage and project-jobs manage are different permissions; the
    // panel must not collapse them into one flag.
    expect(screen.getByTestId('jobs-panel')).toHaveAttribute('data-can-manage', 'false')
  })

  test('forwards the jobs gate to the Aufgaben panel for its schedule flow', () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    // Same check the Jobs tab uses — mirrored, not invented.
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-can-manage', 'false')
  })

  test('forwards the chat gate so viewers get no live Delegieren link', () => {
    render(<AutomationPanel {...baseProps} canChatInProject={false} initialTab="tasks" />)
    // Without `project:chat` the composer is locked — the panel must say so
    // instead of linking into a dead end. Fail-open (true) until the section
    // threads the server decision through.
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-can-chat', 'false')
  })

  test('chat gate fail-opens while the server decision is not threaded through', () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-can-chat', 'true')
  })
})
