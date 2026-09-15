import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

// Mock the API client — preserve the real SkillApiError/types, stub the fns.
vi.mock('@/adapters/api/skills-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/skills-client')>()
  return {
    ...actual,
    listSkills: vi.fn(),
    listSkillCategories: vi.fn(),
    deleteSkill: vi.fn(),
    updateSkill: vi.fn(),
    setCuratedSkillEnabled: vi.fn(),
  }
})

// Toasts are asserted through the mock (no <Toaster /> in these renders).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

// The real portal lands in the layout header; unit tests have no slot.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => children,
}))

import * as client from '@/adapters/api/skills-client'
import { SkillsPanel } from './skills-panel'
import { SkillToolbox } from './skill-toolbox'

const listSkillsMock = vi.mocked(client.listSkills)
const listSkillCategoriesMock = vi.mocked(client.listSkillCategories)
const deleteSkillMock = vi.mocked(client.deleteSkill)
const updateSkillMock = vi.mocked(client.updateSkill)
const setCuratedSkillEnabledMock = vi.mocked(client.setCuratedSkillEnabled)

const orgSkill: client.SkillListItem = {
  id: 'skill-1',
  name: 'acoustic-report',
  description: 'Drafts the acoustic compliance report.',
  body: 'Draft a report on sound insulation per OIB Richtlinie 5.',
  metadata: {},
  origin: 'org',
  enabled: true,
  clonedFrom: null,
  categoryId: null,
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
}

const secondOrgSkill: client.SkillListItem = {
  ...orgSkill,
  id: 'skill-2',
  name: 'escape-routes',
  description: 'Checks escape route widths against OIB 2.3.',
  body: 'Verify every escape route against OIB Richtlinie 2.3.',
}

/**
 * A skill Piloti offers the org. No DB row of its own (`id` null) — the switch
 * addresses it by NAME. This fixture is a dashboard-style offer, off until
 * somebody turns it on. Chat-usable FILE offers start on.
 */
const curatedSkill: client.SkillListItem = {
  id: null,
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire-safety guidelines.',
  body: 'Act as a fire-safety reviewer. Check the project against OIB Richtlinie 2.',
  metadata: {},
  origin: 'platform',
  enabled: false,
  clonedFrom: null,
  categoryId: null,
  createdAt: null,
  updatedAt: null,
}

/** The one shape that earns a scope badge: an explicit `grid-agents`. */
const deepOnlyCurated: client.SkillListItem = {
  ...curatedSkill,
  name: 'long-form-report-writer',
  metadata: { 'grid-agents': 'deep_researcher' },
  enabled: true,
}

const noop = () => {}

/** listSkills answers the envelope; tests pass the rows, categories default to none. */
const toolbox = (
  skills: client.SkillListItem[],
  categories: client.SkillCategoryListItem[] = [],
) => listSkillsMock.mockResolvedValue({ skills, categories })

describe('SkillToolbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSkillCategoriesMock.mockResolvedValue([])
  })

  test('featured leads, the org’s own follow, and both are on the page', async () => {
    toolbox([curatedSkill, orgSkill, secondOrgSkill, deepOnlyCurated])
    render(<SkillToolbox canManage onEdit={noop} />)

    // Both halves are visible: what Piloti curates is the point of the page,
    // not an appendix folded behind a chevron.
    expect(await screen.findByRole('heading', { name: 'Featured skills' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your skills' })).toBeInTheDocument()
    expect(screen.getByText('oib-fire-check')).toBeInTheDocument()
    expect(screen.getByText('acoustic-report')).toBeInTheDocument()
    expect(screen.getByText('escape-routes')).toBeInTheDocument()
    // The count that carries information is how many are ON, not how many exist.
    expect(screen.getByText('1 of 2 on')).toBeInTheDocument()
    // Featured, and only featured, names who maintains it.
    expect(screen.getAllByText('Curated by Piloti')).toHaveLength(2)
    // Nothing on a skill card says anything about time or output any more:
    // a skill does not know when it runs, and a job decides what a run makes.
    expect(screen.queryByText(/schedulable/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Chat mode')).not.toBeInTheDocument()
    // Clone is gone from the product, not just from the built-ins.
    expect(screen.queryByRole('button', { name: /clone|copy/i })).not.toBeInTheDocument()
  })

  test('a featured card badges its scope only where there is one', async () => {
    toolbox([curatedSkill, deepOnlyCurated])
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByText('oib-fire-check')).toBeInTheDocument()
    expect(screen.getByText('long-form-report-writer')).toBeInTheDocument()
    // One of the two declares `grid-agents`; the other reaches both agents,
    // which is the default and therefore says nothing worth a badge.
    expect(screen.getAllByText('Deep research only')).toHaveLength(1)
    expect(screen.queryByText('Chat agent only')).not.toBeInTheDocument()
  })

  test('switching an offer on stores the decision by name', async () => {
    toolbox([curatedSkill])
    setCuratedSkillEnabledMock.mockResolvedValue({ ...curatedSkill, enabled: true })
    render(<SkillToolbox canManage onEdit={noop} />)

    const toggle = await screen.findByRole('switch', {
      name: /Use the Piloti skill .oib-fire-check./,
    })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    // Optimistic: the switch moves before the request settles.
    expect(toggle).toBeChecked()
    await waitFor(() =>
      expect(setCuratedSkillEnabledMock).toHaveBeenCalledWith('oib-fire-check', true),
    )
  })

  test('a failed switch goes back where it was', async () => {
    toolbox([curatedSkill])
    setCuratedSkillEnabledMock.mockRejectedValue(new Error('boom'))
    render(<SkillToolbox canManage onEdit={noop} />)

    const toggle = await screen.findByRole('switch', {
      name: /Use the Piloti skill .oib-fire-check./,
    })
    fireEvent.click(toggle)
    // Optimistic FIRST, so the assertion below is a real state change rather
    // than a switch that never moved.
    expect(toggle).toBeChecked()

    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(setCuratedSkillEnabledMock).toHaveBeenCalledWith('oib-fire-check', true)
  })

  test('an org skill carries the same switch, on its own `enabled`', async () => {
    toolbox([orgSkill])
    updateSkillMock.mockResolvedValue({ ...orgSkill, enabled: false })
    render(<SkillToolbox canManage onEdit={noop} />)

    const toggle = await screen.findByRole('switch', {
      name: /Use the skill .acoustic-report./,
    })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledWith('skill-1', { enabled: false }))
    // A switched-off card says so in words too — a toggle's position alone is
    // not a great place to learn the agent will never reach this skill.
    expect(await screen.findByText('Switched off')).toBeInTheDocument()
  })

  test('expands a collapsible verbatim instruction body', async () => {
    toolbox([orgSkill])
    render(<SkillToolbox canManage onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /View instruction/ }))
    expect(
      await screen.findByText(/Draft a report on sound insulation per OIB Richtlinie 5\./),
    ).toBeInTheDocument()
  })

  test('org rows offer edit and delete', async () => {
    toolbox([orgSkill])
    const onEdit = vi.fn()
    render(<SkillToolbox canManage onEdit={onEdit} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }))
    expect(onEdit).toHaveBeenCalledWith(orgSkill)
  })

  test('delete asks for confirmation, then removes the row', async () => {
    toolbox([orgSkill])
    deleteSkillMock.mockResolvedValue()
    render(<SkillToolbox canManage onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete skill' }))

    await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith('skill-1'))
    await waitFor(() => expect(screen.queryByText('acoustic-report')).not.toBeInTheDocument())
  })

  test('an org with no skills of its own still sees what is on offer', async () => {
    toolbox([curatedSkill])
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByText('No skills yet')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Featured skills' })).toBeInTheDocument()
  })

  test('with nothing curated, the page carries no section headings at all', async () => {
    toolbox([orgSkill])
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByText('acoustic-report')).toBeInTheDocument()
    // "Your skills" over the only list on the page is a label for the page,
    // which the page already has.
    expect(screen.queryByRole('heading', { name: 'Featured skills' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your skills' })).not.toBeInTheDocument()
  })

  test('re-fetches when the panel bumps the reload key', async () => {
    toolbox([orgSkill])
    const { rerender } = render(<SkillToolbox canManage onEdit={noop} reloadKey={0} />)

    await waitFor(() => expect(listSkillsMock).toHaveBeenCalledTimes(1))
    rerender(<SkillToolbox canManage onEdit={noop} reloadKey={1} />)
    await waitFor(() => expect(listSkillsMock).toHaveBeenCalledTimes(2))
  })

  test('is read-only without org:skills:manage', async () => {
    toolbox([curatedSkill, orgSkill])
    render(<SkillToolbox canManage={false} onEdit={noop} />)

    expect(await screen.findByText('acoustic-report')).toBeInTheDocument()
    expect(screen.getByText('oib-fire-check')).toBeInTheDocument()
    // Reading stays available; deciding does not — neither half has a switch.
    expect(screen.getAllByRole('button', { name: /View instruction/ })).toHaveLength(2)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit|Delete/ })).not.toBeInTheDocument()
  })

  test('surfaces a retryable error when the list fails to load', async () => {
    listSkillsMock.mockRejectedValue(new Error('boom'))
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByText('Your skills could not be loaded.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(listSkillsMock).toHaveBeenCalledTimes(2))
  })

  test('groups each half onto its categories, unsorted last', async () => {
    const recherche: client.SkillCategoryListItem = {
      id: 'cat-1',
      name: 'Recherche',
      description: null,
      slug: 'research',
      sortOrder: 0,
      scope: 'platform',
    }
    toolbox(
      [
        { ...curatedSkill, categoryId: 'cat-1' },
        { ...orgSkill, categoryId: 'cat-1' },
        secondOrgSkill,
      ],
      [recherche],
    )
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByText('oib-fire-check')).toBeInTheDocument()
    // Both halves show the shelf subheading; the unsorted org skill closes.
    expect(screen.getAllByText('Recherche')).toHaveLength(2)
    expect(screen.getByText('Unsorted')).toBeInTheDocument()
  })

  test('search filters by name and offers to show everything', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    toolbox([orgSkill, secondOrgSkill])
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByText('acoustic-report')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search skills'), 'escape')
    expect(screen.queryByText('acoustic-report')).not.toBeInTheDocument()
    expect(screen.getByText('escape-routes')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search skills'), '-xyz-nothing')
    expect(screen.getByText(/No skills match/)).toBeInTheDocument()
  })

  test('a card name opens the drawer with the category on it', async () => {
    toolbox([{ ...orgSkill, categoryId: 'cat-1' }], [
      { id: 'cat-1', name: 'Recherche', description: null, slug: null, sortOrder: 0, scope: 'org' },
    ])
    render(<SkillToolbox canManage onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /Open the skill “acoustic-report”/ }))
    const drawer = await screen.findByTestId('skill-detail')
    expect(drawer).toBeInTheDocument()
    expect(drawer).toHaveTextContent('Recherche')
  })

  test('a `?skill=` deep link opens that skill', async () => {
    window.history.replaceState(null, '', '/?skill=skill-1')
    toolbox([orgSkill])
    render(<SkillToolbox canManage onEdit={noop} />)

    expect(await screen.findByTestId('skill-detail')).toBeInTheDocument()
  })
})

describe('SkillsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSkillCategoriesMock.mockResolvedValue([])
    window.history.replaceState(null, '', '/')
  })

  test('is the skill list and the editor — nothing schedule-shaped', async () => {
    toolbox([orgSkill])
    render(<SkillsPanel canManageOrgSkills />)

    // Title lives in the shared layout chrome — this panel must not ship a second h1.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByText('Skill toolbox')).not.toBeInTheDocument()
    expect(await screen.findByText('acoustic-report')).toBeInTheDocument()
    // Jobs live on their own tab; this one must not grow a second copy.
    expect(screen.queryByRole('button', { name: /New job|New schedule/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument()
  })

  test('the editor is rebuilt per open, so it never shows the last skill', async () => {
    toolbox([orgSkill, secondOrgSkill])
    render(<SkillsPanel canManageOrgSkills />)

    const [first, second] = await screen.findAllByRole('button', { name: /^Edit$/ })

    fireEvent.click(first)
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('acoustic-report')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // The second open must not still be the first. It was: every field of this
    // dialog is seeded in a state INITIALISER, and the dialog stayed mounted.
    fireEvent.click(second)
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('escape-routes'))
  })

  test('a new skill opens an empty form even after editing one', async () => {
    toolbox([orgSkill])
    render(<SkillsPanel canManageOrgSkills />)

    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }))
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('acoustic-report')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: /New skill/ }))
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue(''))
  })
})
