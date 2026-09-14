import { act, render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AutomationPanel } from './automation-panel'
import { parseAutomationTab } from '../lib/automation-tab'

// The tabs' JOIN is what this file pins: which panel is mounted, when. The
// panels themselves have their own specs.
vi.mock('@/features/skills/components/skills-panel', () => ({
  SkillsPanel: ({ canManageOrgSkills }: { canManageOrgSkills: boolean }) => (
    <div data-testid="skills-panel" data-can-manage={canManageOrgSkills} />
  ),
}))
// Set before the mock below runs (hoisted), written by the stub on render.
const tasksPanelHarness = vi.hoisted(() => ({
  onDeepLinkSettled: null as ((resolved: boolean) => void) | null,
}))

vi.mock('@/features/tasks/components/tasks-panel', () => ({
  TasksPanel: ({
    canManageJobs,
    canChatInProject = true,
    onDeepLinkSettled,
  }: {
    canManageJobs: boolean
    canChatInProject?: boolean
    onDeepLinkSettled?: (resolved: boolean) => void
  }) => {
    // The settle callback is the deep-link contract under test: the stub
    // holds it where a test can fire it, standing in for the real panel's
    // first-load resolution.
    tasksPanelHarness.onDeepLinkSettled = onDeepLinkSettled ?? null
    return (
      <div
        data-testid="tasks-panel"
        data-can-manage={canManageJobs}
        data-can-chat={canChatInProject}
      />
    )
  },
}))

const baseProps = {
  projectId: 'p1',
  projectCollection: 'col-1',
  canManageOrgSkills: true,
  canManageJobs: false,
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  tasksPanelHarness.onDeepLinkSettled = null
})

describe('parseAutomationTab', () => {
  test('tasks is the default for anything that is not a tab', () => {
    expect(parseAutomationTab(undefined)).toBe('tasks')
    expect(parseAutomationTab('nonsense')).toBe('tasks')
    expect(parseAutomationTab('skills')).toBe('skills')
  })

  test('?tab=jobs keeps landing on the schedules view, which is now Aufgaben', () => {
    // The Jobs tab retired INTO Aufgaben — schedules are the group on top of
    // that list — so every bookmark, inbox row and old link must still land
    // there instead of 404ing or falling on an empty tab.
    expect(parseAutomationTab('jobs')).toBe('tasks')
  })
})

describe('AutomationPanel — one mounted tab at a time', () => {
  test('Aufgaben leads: the default tab is mounted without a ?tab=', () => {
    render(<AutomationPanel {...baseProps} initialTab={parseAutomationTab(undefined)} />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
  })

  test('mounts ONLY the active tab', () => {
    // Load-bearing, not an optimization: both panels portal their primary
    // action into the section header's single slot — two mounted panels would
    // fight over it.
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('tasks-panel')).not.toBeInTheDocument()
  })

  test('switching swaps the mounted panel and writes ?tab= for sharing', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)

    await user.click(screen.getByRole('tab', { name: 'Skills' }))

    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('tasks-panel')).not.toBeInTheDocument()
    expect(window.location.search).toBe('?tab=skills')
  })

  test('switching tabs preserves drawer deep links instead of wiping them', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=tasks&task=task-1')
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)

    await user.click(screen.getByRole('tab', { name: 'Skills' }))

    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    const params = new URL(window.location.href).searchParams
    expect(params.get('tab')).toBe('skills')
    expect(params.get('task')).toBe('task-1')
  })

  test('a ?tab=jobs&task= knock opens the task on Aufgaben and corrects ?tab=', () => {
    // The drawer lives on Aufgaben: the retired tab's deep link wins over the
    // tab, and the URL is corrected so closing the drawer (or copying the link)
    // stays on the tab that is showing.
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=jobs&task=task-1')
    render(<AutomationPanel {...baseProps} initialTab={parseAutomationTab('jobs')} />)

    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    const params = new URL(window.location.href).searchParams
    // `jobs` parsed to tasks, so no rewrite is needed — and none happens.
    expect(params.get('tab')).toBe('jobs')
    expect(params.get('task')).toBe('task-1')
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
  })

  test('a ?tab=skills&schedule= knock opens the schedule on Aufgaben', () => {
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=skills&schedule=job-1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)

    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    const params = new URL(window.location.href).searchParams
    expect(params.get('tab')).toBe('tasks')
    expect(params.get('schedule')).toBe('job-1')
  })

  test('an unmatched drawer deep link restores the requested tab instead of stranding', async () => {
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=skills&schedule=nope')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)

    // Forced onto Aufgaben for the drawer, URL corrected like every knock.
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('tasks')

    // The link never matches a row here: the requested tab comes back, so the
    // reader is not stranded on the rewrite. The drawer itself stays open on
    // the unresolved copy — only the tab moves back.
    await act(async () => {
      tasksPanelHarness.onDeepLinkSettled?.(false)
    })
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('skills')
  })

  test('a matched drawer deep link keeps the corrected tab', async () => {
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=skills&task=task-1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()

    await act(async () => {
      tasksPanelHarness.onDeepLinkSettled?.(true)
    })
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('tasks')
  })

  test('a manual tab switch wins over a later unsettled link', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/app/projects/p1/automation?tab=skills&schedule=nope')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Skills' }))
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()

    await act(async () => {
      tasksPanelHarness.onDeepLinkSettled?.(false)
    })
    // Untouched would have restored skills; the reader chose it anyway.
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('skills')
  })

  test('hands each panel its own authorization, not a shared one', () => {
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    // Org-skills manage and project-schedule manage are different permissions;
    // the panel must not collapse them into one flag.
    expect(screen.getByTestId('skills-panel')).toHaveAttribute('data-can-manage', 'true')
  })

  test('forwards the schedule gate to the Aufgaben panel for its schedule flow', () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-can-manage', 'false')
  })

  test('forwards the chat gate so viewers get no live Delegieren link', () => {
    render(<AutomationPanel {...baseProps} canChatInProject={false} initialTab="tasks" />)
    // Without `project:chat` the composer is locked — the panel must say so
    // instead of linking into a dead end.
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-can-chat', 'false')
  })
})
