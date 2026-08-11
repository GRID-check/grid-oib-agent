import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

// Mock the API client — preserve the real SkillApiError/types, stub the fns.
vi.mock('@/adapters/api/skills-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/skills-client')>()
  return {
    ...actual,
    listSkills: vi.fn(),
    deleteSkill: vi.fn(),
  }
})

// Toasts are asserted through the mock (no <Toaster /> in these renders).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import * as client from '@/adapters/api/skills-client'
import { SkillsPanel } from './skills-panel'
import { SkillToolbox } from './skill-toolbox'

const listSkillsMock = vi.mocked(client.listSkills)
const deleteSkillMock = vi.mocked(client.deleteSkill)

const platformSkill: client.SkillListItem = {
  id: null,
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire-safety guidelines.',
  body: 'Act as a fire-safety reviewer. Check the project against OIB Richtlinie 2.',
  metadata: {},
  origin: 'platform',
  enabled: true,
  clonedFrom: null,
  createdAt: null,
  updatedAt: null,
}

const orgSkill: client.SkillListItem = {
  id: 'skill-1',
  name: 'acoustic-report',
  description: 'Drafts the acoustic compliance report.',
  body: 'Draft a report on sound insulation per OIB Richtlinie 5.',
  metadata: {},
  origin: 'org',
  enabled: true,
  clonedFrom: null,
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
}

/** The one shape that earns a scope badge: an explicit `grid-agents`. */
const deepOnlySkill: client.SkillListItem = {
  ...platformSkill,
  id: null,
  name: 'long-form-report-writer',
  metadata: { 'grid-agents': 'deep_researcher' },
}

const clonedSkill: client.SkillListItem = {
  ...platformSkill,
  id: 'skill-2',
  name: 'oib-fire-check-adapt',
  origin: 'platform-clone',
  clonedFrom: 'oib-fire-check',
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
}

const noop = () => {}

describe('SkillToolbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders the merged toolbox with origin and scope badges', async () => {
    listSkillsMock.mockResolvedValue([platformSkill, orgSkill, clonedSkill, deepOnlySkill])
    render(<SkillToolbox canManage onClone={noop} onEdit={noop} />)

    expect(await screen.findByText('acoustic-report')).toBeInTheDocument()
    expect(screen.getByText('oib-fire-check')).toBeInTheDocument()
    expect(screen.getByText('oib-fire-check-adapt')).toBeInTheDocument()
    // Origin badges for every row type (two builtins in this fixture).
    expect(screen.getAllByText('Built-in')).toHaveLength(2)
    expect(screen.getByText('In this organization')).toBeInTheDocument()
    expect(screen.getByText('Cloned')).toBeInTheDocument()
    // Scope is badged ONLY where there is one. Three of these four skills
    // reach both agents — which is the default — so a badge on each of them
    // would be three badges saying nothing.
    expect(screen.getAllByText('Deep research only')).toHaveLength(1)
    expect(screen.queryByText('Chat agent only')).not.toBeInTheDocument()
    // Nothing on a skill card says anything about time or output any more:
    // a skill does not know when it runs, and a job decides what a run makes.
    expect(screen.queryByText(/schedulable/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Chat mode')).not.toBeInTheDocument()
  })

  test('expands a collapsible verbatim instruction body', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    render(<SkillToolbox canManage onClone={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /View instruction/ }))
    expect(
      await screen.findByText(/Act as a fire-safety reviewer\. Check the project against OIB Richtlinie 2\./),
    ).toBeInTheDocument()
  })

  test('platform rows offer clone; org rows offer edit and delete', async () => {
    listSkillsMock.mockResolvedValue([platformSkill, orgSkill])
    const onClone = vi.fn()
    const onEdit = vi.fn()
    render(<SkillToolbox canManage onClone={onClone} onEdit={onEdit} />)

    fireEvent.click(await screen.findByRole('button', { name: /Clone skill .oib-fire-check./ }))
    expect(onClone).toHaveBeenCalledWith(platformSkill)

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    expect(onEdit).toHaveBeenCalledWith(orgSkill)
  })

  test('delete asks for confirmation, then removes the row', async () => {
    listSkillsMock.mockResolvedValue([orgSkill])
    deleteSkillMock.mockResolvedValue()
    render(<SkillToolbox canManage onClone={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete skill' }))

    await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith('skill-1'))
    await waitFor(() => expect(screen.queryByText('acoustic-report')).not.toBeInTheDocument())
  })

  test('is read-only without org:skills:manage', async () => {
    listSkillsMock.mockResolvedValue([platformSkill, orgSkill])
    render(<SkillToolbox canManage={false} onClone={noop} onEdit={noop} />)

    expect(await screen.findByText('oib-fire-check')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New skill/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Clone|Edit|Delete/ })).not.toBeInTheDocument()
  })

  test('surfaces a retryable error when the list fails to load', async () => {
    listSkillsMock.mockRejectedValue(new Error('boom'))
    render(<SkillToolbox canManage onClone={noop} onEdit={noop} />)

    expect(await screen.findByText('The skill toolbox could not be loaded.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(listSkillsMock).toHaveBeenCalledTimes(2))
  })
})

describe('SkillsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('is the toolbox and the editor — nothing schedule-shaped', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    render(<SkillsPanel canManageOrgSkills />)

    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('Skill toolbox')).toBeInTheDocument()
    expect(await screen.findByText('oib-fire-check')).toBeInTheDocument()
    // Jobs live on their own tab; this one must not grow a second copy.
    expect(screen.queryByRole('button', { name: /New job|New schedule/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument()
  })

  test('cloning a built-in skill opens the editor seeded from it', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    render(<SkillsPanel canManageOrgSkills />)

    fireEvent.click(await screen.findByRole('button', { name: /Clone skill .oib-fire-check./ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('New skill')
    expect(dialog).toHaveTextContent('Cloned from “oib-fire-check”')
  })
})
