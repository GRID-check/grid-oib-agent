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
  test('jobs is the default for anything that is not skills', () => {
    expect(parseAutomationTab(undefined)).toBe('jobs')
    expect(parseAutomationTab('nonsense')).toBe('jobs')
    expect(parseAutomationTab('skills')).toBe('skills')
  })
})

describe('AutomationPanel — one mounted tab at a time', () => {
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

  test('hands each panel its own authorization, not a shared one', () => {
    render(<AutomationPanel {...baseProps} initialTab="jobs" />)
    // Org-skills manage and project-jobs manage are different permissions; the
    // panel must not collapse them into one flag.
    expect(screen.getByTestId('jobs-panel')).toHaveAttribute('data-can-manage', 'false')
  })
})
