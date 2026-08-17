import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

// Mock the API client — preserve the real JobApiError/types, stub the fns.
vi.mock('@/adapters/api/jobs-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/jobs-client')>()
  return {
    ...actual,
    listJobs: vi.fn(),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
    runJob: vi.fn(),
    listJobRuns: vi.fn(),
    listAttachableSkills: vi.fn(),
  }
})

// Toasts are asserted through the mock (no <Toaster /> in these renders).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

// The real portal lands in the layout header; unit tests have no slot.
vi.mock('@/components/shell', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => children,
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

// The builder fetches the data sources on mount; keep one.
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
import * as client from '@/adapters/api/jobs-client'
import * as researchRunsClient from '@/adapters/api/research-runs-client'
import { JobsPanel } from './jobs-panel'
import { JobBuilder } from './job-builder'
import { JobList } from './job-list'

const listJobsMock = vi.mocked(client.listJobs)
const createJobMock = vi.mocked(client.createJob)
const updateJobMock = vi.mocked(client.updateJob)
const deleteJobMock = vi.mocked(client.deleteJob)
const runJobMock = vi.mocked(client.runJob)
const listJobRunsMock = vi.mocked(client.listJobRuns)
const listAttachableSkillsMock = vi.mocked(client.listAttachableSkills)
const listResearchRunsMock = vi.mocked(researchRunsClient.listResearchRuns)

const chatSkill: client.AttachableSkill = {
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire-safety guidelines.',
  body: 'Act as a fire-safety reviewer.',
  metadata: {},
  origin: 'platform',
}

const deepSkill: client.AttachableSkill = {
  name: 'long-form-report-writer',
  description: 'Writes the long-form report.',
  body: 'Write a structured report.',
  metadata: { 'grid-agents': 'deep_researcher' },
  origin: 'org',
}

const sampleJob: client.Job = {
  id: 'j1',
  projectId: 'p1',
  name: 'Weekly OIB scan',
  prompt: 'Check the project documents for open fire-safety points.',
  skillName: null,
  skillSnapshot: null,
  output: 'chat',
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

const jobWithSkill: client.Job = {
  ...sampleJob,
  id: 'j2',
  name: 'Acoustic report',
  output: 'deep-research',
  skillName: deepSkill.name,
  skillSnapshot: {
    name: deepSkill.name,
    description: deepSkill.description,
    body: deepSkill.body,
    metadata: deepSkill.metadata,
    origin: deepSkill.origin,
  },
}

const submittedRun: client.JobRun = {
  id: 'r1',
  scheduleId: 'j1',
  jobId: 'job-1',
  trigger: 'manual',
  status: 'submitted',
  detail: null,
  conversationId: null,
  skillSnapshot: {
    name: chatSkill.name,
    description: chatSkill.description,
    body: chatSkill.body,
    metadata: chatSkill.metadata,
    origin: chatSkill.origin,
  },
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

describe('JobList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('a card says what the job SENDS, not only what it is called', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    expect(screen.getByText(sampleJob.prompt)).toBeInTheDocument()
    expect(screen.getByText(/Weekly on Monday at 06:00 · Europe\/Vienna/)).toBeInTheDocument()
    // No skill is the common case, and it is STATED rather than left blank.
    expect(screen.getByText('No skill')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run now/ })).toBeInTheDocument()
  })

  test('an attached skill is named on the card', async () => {
    listJobsMock.mockResolvedValue([jobWithSkill])
    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    expect(await screen.findByText(`Skill: ${deepSkill.name}`)).toBeInTheDocument()
    expect(screen.getByText('Report')).toBeInTheDocument()
  })

  test('is read-only without project:skills:manage', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    render(
      <JobList projectId="p1" projectCollection="proj_1" canManage={false} onCreate={noop} onEdit={noop} />,
    )

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$|^Delete$/ })).not.toBeInTheDocument()
  })

  test('starting a run reveals it: history opens and shows the live job status', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    runJobMock.mockResolvedValue({ status: 'submitted', jobId: 'job-1' })
    listJobRunsMock.mockResolvedValue([submittedRun])
    listResearchRunsMock.mockResolvedValue(researchRun('running'))

    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))

    // The run history opens by itself — the started run must not be invisible.
    await waitFor(() => expect(listJobRunsMock).toHaveBeenCalledWith('p1', 'j1', { limit: 20 }))
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View progress/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?job=job-1&tab=tasks',
    )
  })

  test('the run-started toast jumps straight into the running job', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    runJobMock.mockResolvedValue({ status: 'submitted', jobId: 'job-1' })
    listJobRunsMock.mockResolvedValue([submittedRun])
    listResearchRunsMock.mockResolvedValue(researchRun('running'))

    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

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
    listJobsMock.mockResolvedValue([sampleJob])
    runJobMock.mockResolvedValue({ status: 'skipped', detail: 'Org job cap reached' })

    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Run skipped', {
        description: 'Org job cap reached',
      }),
    )
  })

  test('the enable switch toggles optimistically', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    updateJobMock.mockResolvedValue({ ...sampleJob, enabled: false })
    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('switch', { name: /Disable job/ }))

    await waitFor(() => expect(updateJobMock).toHaveBeenCalledWith('p1', 'j1', { enabled: false }))
  })

  test('delete asks for confirmation, then removes the card', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    deleteJobMock.mockResolvedValue()
    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete job' }))

    await waitFor(() => expect(deleteJobMock).toHaveBeenCalledWith('p1', 'j1'))
    await waitFor(() => expect(screen.queryByText('Weekly OIB scan')).not.toBeInTheDocument())
  })

  test('shows the empty state and a create action', async () => {
    listJobsMock.mockResolvedValue([])
    const onCreate = vi.fn()
    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={onCreate} onEdit={noop} />)

    expect(await screen.findByText('No jobs yet')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'New job' })[0])
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('surfaces a retryable error when the list fails to load', async () => {
    listJobsMock.mockRejectedValue(new Error('boom'))
    render(<JobList projectId="p1" projectCollection="proj_1" canManage onCreate={noop} onEdit={noop} />)

    expect(await screen.findByText('The jobs could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('JobBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listAttachableSkillsMock.mockResolvedValue([chatSkill])
  })

  test('the prompt is the job: it is submitted verbatim, with no skill attached', async () => {
    createJobMock.mockResolvedValue(sampleJob)
    const onSaved = vi.fn()
    render(<JobBuilder projectId="p1" job={null} onSaved={onSaved} onCancel={noop} />)

    fireEvent.change(await screen.findByLabelText(/Name/), { target: { value: 'Monday scan' } })
    fireEvent.change(screen.getByLabelText(/What this job asks/), {
      target: { value: 'Check the fire-safety points.' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Save job/ }))

    await waitFor(() =>
      expect(createJobMock).toHaveBeenCalledWith('p1', {
        name: 'Monday scan',
        prompt: 'Check the fire-safety points.',
        output: 'chat',
        // Explicitly null, never omitted — on PATCH that is what detaches.
        skillName: null,
        dataSources: null,
        enabled: true,
        scheduleCron: null,
        scheduleTimezone: expect.any(String),
      }),
    )
    expect(onSaved).toHaveBeenCalled()
  })

  test('the preview is the prompt itself when nothing is attached', async () => {
    render(<JobBuilder projectId="p1" job={null} onSaved={noop} onCancel={noop} />)

    fireEvent.change(await screen.findByLabelText(/What this job asks/), {
      target: { value: '  Check the fire-safety points.  ' },
    })

    const preview = await screen.findByTestId('job-prompt-preview')
    expect(preview).toHaveTextContent('Check the fire-safety points.')
    // No fences, no Skill:/Beschreibung: block — the trimmed prompt, verbatim.
    expect(preview.textContent).toBe('Check the fire-safety points.')
  })

  test('the attached skill is embedded in the preview under the prompt', async () => {
    // Stub BEFORE render: the picker effect fetches on mount and drops an
    // attachment the returned list cannot offer. Setting it afterwards would
    // let the default `[chatSkill]` detach this deep-only skill first, and the
    // test would be measuring the detach path while claiming to measure the
    // preview.
    listAttachableSkillsMock.mockResolvedValue([deepSkill])
    render(<JobBuilder projectId="p1" job={jobWithSkill} onSaved={noop} onCancel={noop} />)
    const preview = await screen.findByTestId('job-prompt-preview')
    await waitFor(() => expect(preview.textContent).toContain(`Skill: ${deepSkill.name}`))
    expect(preview.textContent).toContain(jobWithSkill.prompt)
    expect(preview.textContent).toContain(deepSkill.body)
  })

  test('switching the output re-filters the picker and says when it detached a skill', async () => {
    // The saved job is deep-research with a deep-only skill; switching to chat
    // leaves a picker that cannot offer it.
    listAttachableSkillsMock.mockImplementation(async (output) =>
      output === 'deep-research' ? [deepSkill] : [chatSkill],
    )
    render(<JobBuilder projectId="p1" job={jobWithSkill} onSaved={noop} onCancel={noop} />)

    await waitFor(() => expect(listAttachableSkillsMock).toHaveBeenCalledWith('deep-research'))

    fireEvent.click(screen.getByRole('radio', { name: /Chat/ }))

    await waitFor(() => expect(listAttachableSkillsMock).toHaveBeenCalledWith('chat'))
    // Said out loud, not silently dropped.
    expect(
      await screen.findByText(new RegExp(`${deepSkill.name}.*cannot run as Chat`)),
    ).toBeInTheDocument()
    // And the preview follows: the skill block is gone.
    const preview = await screen.findByTestId('job-prompt-preview')
    expect(preview.textContent).not.toContain(`Skill: ${deepSkill.name}`)
  })

  test('an empty prompt cannot be saved, and the form says why once asked', async () => {
    render(<JobBuilder projectId="p1" job={null} onSaved={noop} onCancel={noop} />)

    fireEvent.change(await screen.findByLabelText(/Name/), { target: { value: 'No prompt' } })

    // Two halves, and both matter. The save is DISABLED, so a job with no
    // prompt cannot be created by clicking at it...
    expect(screen.getByRole('button', { name: /Save job/ })).toBeDisabled()

    // ...and the field explains itself as soon as the author has been near it.
    // Errors stay hidden until a field is touched, so an untouched form is not
    // covered in red before anyone has typed a character.
    const prompt = screen.getByLabelText(/What this job asks/)
    fireEvent.change(prompt, { target: { value: 'x' } })
    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.blur(prompt)

    await waitFor(() => expect(screen.getByText('A prompt is required.')).toBeInTheDocument())
    expect(createJobMock).not.toHaveBeenCalled()
  })
})

describe('JobsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listAttachableSkillsMock.mockResolvedValue([chatSkill])
  })

  test('list mode renders the jobs', async () => {
    listJobsMock.mockResolvedValue([sampleJob])
    render(<JobsPanel projectId="p1" projectCollection="proj_1" canManage />)

    expect(screen.queryByRole('heading', { name: 'Jobs', level: 1 })).not.toBeInTheDocument()
    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
  })

  test('“New job” switches to the builder; cancelling returns to the list', async () => {
    listJobsMock.mockResolvedValue([])
    render(<JobsPanel projectId="p1" projectCollection="proj_1" canManage />)

    fireEvent.click(await screen.findByRole('button', { name: 'New job' }))
    expect(await screen.findByRole('button', { name: 'Back to jobs' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument()
  })
})
