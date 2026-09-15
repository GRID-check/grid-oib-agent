/**
 * The Automation section's tabs — which panel is mounted, when.
 *
 * The join is all this file pins; the three panels have specs of their own. Two
 * properties carry it:
 *
 *   - **Only the active tab mounts.** Load-bearing rather than an optimization:
 *     the panels portal their primary action into ONE header slot, so two
 *     mounted panels would fight over it — and the timetable's cron expansion
 *     would load for readers who never open Zeitplan.
 *   - **A drawer deep link picks its own tab.** `?task=` lives on Tasks and
 *     `?schedule=` on Zeitplan, one each, which is what replaced the
 *     force-a-tab-then-restore-it dance the merged list needed.
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
    onPromoteToSchedule,
  }: {
    canManageJobs: boolean
    canChatInProject?: boolean
    onPromoteToSchedule?: (draft: { name: string; prompt: string }) => void
  }) => (
    <div data-testid="tasks-panel" data-can-manage={canManageJobs} data-can-chat={canChatInProject}>
      <button
        type="button"
        data-testid="stub-promote"
        onClick={() => onPromoteToSchedule?.({ name: 'Aktenvermerk', prompt: 'Prüfe das wöchentlich' })}
      >
        promote
      </button>
    </div>
  ),
}))

vi.mock('@/features/jobs/components/schedule-panel', () => ({
  SchedulePanel: ({
    canManageJobs,
    draft,
  }: {
    canManageJobs: boolean
    draft?: { name: string; prompt: string } | null
  }) => (
    <div
      data-testid="schedule-panel"
      data-can-manage={canManageJobs}
      data-draft={draft ? draft.prompt : ''}
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

  test('names the three tabs', () => {
    expect(parseAutomationTab('tasks')).toBe('tasks')
    expect(parseAutomationTab('schedule')).toBe('schedule')
    expect(parseAutomationTab('skills')).toBe('skills')
  })

  test('the retired Jobs tab now lands on Zeitplan, which is what it always showed', () => {
    expect(parseAutomationTab('jobs')).toBe('schedule')
  })
})

describe('tabForDeepLink', () => {
  test('each drawer param has exactly one home tab', () => {
    expect(tabForDeepLink(new URLSearchParams('task=t1'))).toBe('tasks')
    expect(tabForDeepLink(new URLSearchParams('schedule=j1'))).toBe('schedule')
    expect(tabForDeepLink(new URLSearchParams('tab=skills'))).toBeNull()
  })
})

describe('which panel is mounted', () => {
  test('Tasks leads, and nothing else is mounted beside it', () => {
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('schedule-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
  })

  test('switching a tab mounts one panel and unmounts the other', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} initialTab="tasks" />)
    await user.click(screen.getByRole('tab', { name: /schedule/i }))
    expect(screen.getByTestId('schedule-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('tasks-panel')).not.toBeInTheDocument()
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
})

describe('a drawer deep link', () => {
  test('`?schedule=` opens Zeitplan even when `?tab=` said otherwise', () => {
    window.history.replaceState(null, '', '/?tab=skills&schedule=j1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(screen.getByTestId('schedule-panel')).toBeInTheDocument()
  })

  test('…and corrects `?tab=` so a copied link reopens the same view', () => {
    window.history.replaceState(null, '', '/?tab=skills&task=t1')
    render(<AutomationPanel {...baseProps} initialTab="skills" />)
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('tasks')
    // The drawer param survives the correction — it is the whole point of it.
    expect(new URL(window.location.href).searchParams.get('task')).toBe('t1')
  })
})

describe('turning a task into a schedule', () => {
  test('switches to Zeitplan and hands the draft over', async () => {
    const user = userEvent.setup()
    render(<AutomationPanel {...baseProps} canManageJobs initialTab="tasks" />)
    await user.click(screen.getByTestId('stub-promote'))
    const panel = screen.getByTestId('schedule-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveAttribute('data-draft', 'Prüfe das wöchentlich')
  })
})
