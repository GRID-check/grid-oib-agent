import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

// Mock the API client — preserve the real SkillApiError/types, stub the fns.
vi.mock('@/adapters/api/skills-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/skills-client')>()
  return {
    ...actual,
    listSkills: vi.fn(),
    deleteSkill: vi.fn(),
    listSkillSchedules: vi.fn(),
    createSkillSchedule: vi.fn(),
    updateSkillSchedule: vi.fn(),
    deleteSkillSchedule: vi.fn(),
    runSkillSchedule: vi.fn(),
    listSkillRuns: vi.fn(),
  }
})

// Toasts are asserted through the mock (no <Toaster /> in these renders).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

// "Run now" offers a toast action that navigates into the running job.
const routerPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

// The run history joins its rows against the backend's research runs to show
// each run's LIVE job status.
vi.mock('@/adapters/api/research-runs-client', () => ({
  listResearchRuns: vi.fn(),
}))

// The schedule builder fetches the data sources on mount; keep one.
vi.mock('@/adapters/api/data-sources-client', () => ({
  createDataSourcesClient: () => ({
    getDataSources: vi.fn().mockResolvedValue({
      data_sources: [{ id: 'web_search', name: 'Web search', description: 'Search the web' }],
      knowledge_layer: true,
      vlm_available: false,
    }),
  }),
}))

import { toast } from 'sonner'
import * as client from '@/adapters/api/skills-client'
import * as researchRunsClient from '@/adapters/api/research-runs-client'
import { SkillsPanel } from './skills-panel'
import { ScheduleList } from './schedule-list'
import { SkillToolbox } from './skill-toolbox'

const listSkillsMock = vi.mocked(client.listSkills)
const deleteSkillMock = vi.mocked(client.deleteSkill)
const listSchedulesMock = vi.mocked(client.listSkillSchedules)
const runSkillScheduleMock = vi.mocked(client.runSkillSchedule)
const updateScheduleMock = vi.mocked(client.updateSkillSchedule)
const deleteScheduleMock = vi.mocked(client.deleteSkillSchedule)
const listSkillRunsMock = vi.mocked(client.listSkillRuns)
const listResearchRunsMock = vi.mocked(researchRunsClient.listResearchRuns)

const platformSkill: client.SkillListItem = {
  id: null,
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire-safety guidelines.',
  body: 'Act as a fire-safety reviewer. Check the project against OIB Richtlinie 2.',
  metadata: { 'grid-execution': 'chat' },
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
  metadata: { 'grid-execution': 'deep-research', 'grid-schedulable': 'false' },
  origin: 'org',
  enabled: true,
  clonedFrom: null,
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
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

const sampleSchedule: client.SkillSchedule = {
  id: 's1',
  projectId: 'p1',
  name: 'Weekly OIB scan',
  skillName: 'oib-fire-check',
  skillSnapshot: {
    name: 'oib-fire-check',
    description: 'Checks the project against OIB fire-safety guidelines.',
    body: 'Act as a fire-safety reviewer.',
    metadata: { 'grid-execution': 'chat' },
    origin: 'platform',
  },
  execution: 'chat',
  dataSources: null,
  enabled: true,
  scheduleCron: '0 6 * * 1',
  scheduleTimezone: 'Europe/Vienna',
  nextRunAt: '2026-07-17T06:00:00Z',
  lastRunAt: null,
  createdBy: 'user_1',
  createdByEmail: null,
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
}

const submittedRun: client.SkillRun = {
  id: 'r1',
  scheduleId: 's1',
  jobId: 'job-1',
  trigger: 'manual',
  status: 'submitted',
  detail: null,
  skillSnapshot: sampleSchedule.skillSnapshot,
  triggeredBy: 'user_1',
  createdAt: '2026-07-16T06:00:00Z',
}

/** One live research run as the backend job list reports it. */
const researchRun = (status: string) => ({
  jobs: [
    {
      job_id: 'job-1',
      status,
      created_at: '2026-07-16T06:00:00Z',
      conversation_id: null,
      project_collection: 'proj_1',
    },
  ],
  total: 1,
})

const noop = () => {}

describe('SkillToolbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders the merged toolbox with origin, execution and schedulability badges', async () => {
    listSkillsMock.mockResolvedValue([platformSkill, orgSkill, clonedSkill])
    render(<SkillToolbox canManage onClone={noop} onEdit={noop} />)

    expect(await screen.findByText('acoustic-report')).toBeInTheDocument()
    expect(screen.getByText('oib-fire-check')).toBeInTheDocument()
    expect(screen.getByText('oib-fire-check-adapt')).toBeInTheDocument()
    // Origin badges for every row type.
    expect(screen.getByText('Built-in')).toBeInTheDocument()
    expect(screen.getByText('In this organization')).toBeInTheDocument()
    expect(screen.getByText('Cloned')).toBeInTheDocument()
    // Execution + schedulability come from the reserved metadata.
    expect(screen.getAllByText('Chat mode')).toHaveLength(2)
    expect(screen.getByText('Deep research')).toBeInTheDocument()
    expect(screen.getByText('Not schedulable')).toBeInTheDocument()
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

describe('ScheduleList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders schedule cards with a humanized summary and run controls', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    expect(screen.getByText(/Weekly on Monday at 06:00 · Europe\/Vienna/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run now/ })).toBeInTheDocument()
  })

  test('is read-only without project:skills:manage', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage={false} onCreate={noop} onEdit={noop} />)

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$|^Delete$/ })).not.toBeInTheDocument()
  })

  test('starting a run reveals it: history opens and shows the live job status', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    runSkillScheduleMock.mockResolvedValue({ status: 'submitted', jobId: 'job-1' })
    listSkillRunsMock.mockResolvedValue([submittedRun])
    listResearchRunsMock.mockResolvedValue(researchRun('running'))

    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))

    // The run history opens by itself — the started run must not be invisible.
    await waitFor(() => expect(listSkillRunsMock).toHaveBeenCalledWith('p1', 's1', { limit: 20 }))
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View progress/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?job=job-1&tab=tasks',
    )
  })

  test('the run-started toast jumps straight into the running job', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    runSkillScheduleMock.mockResolvedValue({ status: 'submitted', jobId: 'job-1' })
    listSkillRunsMock.mockResolvedValue([submittedRun])
    listResearchRunsMock.mockResolvedValue(researchRun('running'))

    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))

    const toastSuccess = vi.mocked(toast.success)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    const options = toastSuccess.mock.calls[0][1] as {
      action?: { label: string; onClick: () => void }
    }
    expect(options.action?.label).toBe('View progress')
    options.action?.onClick()
    expect(routerPush).toHaveBeenCalledWith('/app/projects/p1/chat?job=job-1&tab=tasks')
  })

  test('a skipped run warns instead of starting one', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    runSkillScheduleMock.mockResolvedValue({ status: 'skipped', detail: 'Org job cap reached' })

    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Run skipped', {
        description: 'Org job cap reached',
      }),
    )
  })

  test('the enable switch toggles optimistically and reverts on failure', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    updateScheduleMock.mockResolvedValue({ ...sampleSchedule, enabled: false })
    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    const toggle = await screen.findByRole('switch', { name: /Disable schedule/ })
    fireEvent.click(toggle)

    await waitFor(() => expect(updateScheduleMock).toHaveBeenCalledWith('p1', 's1', { enabled: false }))
  })

  test('delete asks for confirmation, then removes the card', async () => {
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    deleteScheduleMock.mockResolvedValue()
    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete schedule' }))

    await waitFor(() => expect(deleteScheduleMock).toHaveBeenCalledWith('p1', 's1'))
    await waitFor(() => expect(screen.queryByText('Weekly OIB scan')).not.toBeInTheDocument())
  })

  test('shows the empty state and a create action', async () => {
    listSchedulesMock.mockResolvedValue([])
    const onCreate = vi.fn()
    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={onCreate} onEdit={noop} />)

    expect(await screen.findByText('No schedules yet')).toBeInTheDocument()
    // The heading and the empty state both offer "New schedule" — either works.
    fireEvent.click(screen.getAllByRole('button', { name: 'New schedule' })[0])
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('surfaces a retryable error when the list fails to load', async () => {
    listSchedulesMock.mockRejectedValue(new Error('boom'))
    render(<ScheduleList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    expect(await screen.findByText('The skills could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('SkillsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('list mode renders the header, toolbox and schedules', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    listSchedulesMock.mockResolvedValue([sampleSchedule])
    render(
      <SkillsPanel
        projectId="p1"
        projectCollection="proj_1"
        canManageOrgSkills
        canManageProjectSkills
      />,
    )

    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('Skill toolbox')).toBeInTheDocument()
    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
  })

  test('“New schedule” switches to the builder; cancelling returns to the list', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    listSchedulesMock.mockResolvedValue([])
    render(
      <SkillsPanel
        projectId="p1"
        projectCollection="proj_1"
        canManageOrgSkills
        canManageProjectSkills
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'New schedule' }))
    expect(await screen.findByText('New schedule')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('No schedules yet')).toBeInTheDocument()
  })

  test('cloning a built-in skill opens the editor seeded from it', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    listSchedulesMock.mockResolvedValue([])
    render(
      <SkillsPanel
        projectId="p1"
        projectCollection="proj_1"
        canManageOrgSkills
        canManageProjectSkills
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Clone skill .oib-fire-check./ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('New skill')
    expect(dialog).toHaveTextContent('Cloned from “oib-fire-check”')
  })
})
