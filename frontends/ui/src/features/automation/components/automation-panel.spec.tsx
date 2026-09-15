/**
 * The Automation section's tabs — which panel is mounted, when.
 *
 * The join is all this file pins; the two panels have specs of their own. Two
 * properties carry it:
 *
 *   - **Only the active tab mounts.** Load-bearing rather than an optimization:
 *     the panels portal their primary action into ONE header slot, so two
 *     mounted panels would fight over it.
 *   - **A drawer deep link picks its own tab.** `?task=` and `?schedule=` both
 *     live on Tasks — a run drawer and a standing-task drawer are two drawers
 *     over one list, not two destinations.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AutomationPanel } from './automation-panel'
import { parseAutomationTab, tabForDeepLink } from '../lib/automation-tab'

vi.mock('@/features/skills/components/skills-panel', () => ({
  SkillsPanel: ({ canManageOrgSkills }: { canManageOrgSkills: boolean }) => (
    <div data-testid="skills-panel" data-can-manage={canManageOrgSkills} />
  ),
}))

vi.mock('@/features/tasks/components/tasks-panel', () => ({
  TasksPanel: ({
    canManageJobs,
    canChatInProject = true,
    initialView = 'list',
  }: {
    canManageJobs: boolean
    canChatInProject?: boolean
    initialView?: string
  }) => (
    <div
      data-testid="tasks-panel"
      data-can-manage={canManageJobs}
      data-can-chat={canChatInProject}
      data-view={initialView}
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
  })

  test('names the two tabs', () => {
    expect(parseAutomationTab('tasks')).toBe('tasks')
    expect(parseAutomationTab('skills')).toBe('skills')
  })

  test('retired tab ids land on Tasks', () => {
    expect(parseAutomationTab('jobs')).toBe('tasks')
    expect(parseAutomationTab('schedule')).toBe('tasks')
  })
})

describe('tabForDeepLink', () => {
  test('both drawer params live on Tasks', () => {
    expect(tabForDeepLink(new URLSearchParams('task=t1'))).toBe('tasks')
    expect(tabForDeepLink(new URLSearchParams('schedule=j1'))).toBe('tasks')
    expect(tabForDeepLink(new URLSearchParams('tab=skills'))).toBeNull()
  })
})

describe('which panel is mounted', () => {
  test('Tasks leads, and nothing else is mounted beside it', () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
  })

  test('switching a tab mounts one panel and unmounts the other', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    await user.click(screen.getByRole('tab', { name: /skills/i }))
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('tasks-panel')).not.toBeInTheDocument()
  })

  test('there is no schedule tab anymore', async () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    expect(screen.queryByRole('tab', { name: /zeitplan|schedule/i })).not.toBeInTheDocument()
  })

  test('the tab rides the URL, so the view is shareable without a round trip', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    await user.click(screen.getByRole('tab', { name: /skills/i }))
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('skills')
  })

  test('both permissions reach their own panel, separately', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} canManageJobs canManageOrgSkills={false} initialTab="tasks" />)
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-can-manage', 'true')
    await user.click(screen.getByRole('tab', { name: /skills/i }))
    expect(screen.getByTestId('skills-panel')).toHaveAttribute('data-can-manage', 'false')
  })

  test('a legacy schedule link opens Tasks on the timetable view', () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" initialView="timetable" />)
    expect(screen.getByTestId('tasks-panel')).toHaveAttribute('data-view', 'timetable')
  })
})

describe('a drawer deep link', () => {
  test('`?schedule=` opens Tasks even when `?tab=` said otherwise', () => {
    window.history.replaceState(null, '', '/?tab=skills&schedule=j1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
  })

  test('…and corrects `?tab=` so a copied link reopens the same view', () => {
    window.history.replaceState(null, '', '/?tab=skills&task=t1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('tasks')
    // The drawer param survives the correction — it is the whole point of it.
    expect(new URL(window.location.href).searchParams.get('task')).toBe('t1')
  })
})
