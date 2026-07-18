import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

// Mock the API client — preserve the real WorkflowApiError/types, stub the fns.
vi.mock('@/adapters/api/workflows-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/workflows-client')>()
  return {
    ...actual,
    listWorkflows: vi.fn(),
    getWorkflow: vi.fn(),
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    runWorkflow: vi.fn(),
    listWorkflowRuns: vi.fn(),
  }
})

// Data-sources client is called on builder mount.
vi.mock('@/adapters/api/data-sources-client', () => ({
  createDataSourcesClient: () => ({
    getDataSources: vi.fn().mockResolvedValue({
      data_sources: [{ id: 'web_search', name: 'Web search', description: 'Search the web' }],
      knowledge_layer: true,
      vlm_available: false,
    }),
  }),
}))

import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import * as client from '@/adapters/api/workflows-client'
import { resolveTemplate } from '../lib/templates'
import { WorkflowList } from './workflow-list'
import { WorkflowBuilder } from './workflow-builder'
import { TemplateCards } from './template-cards'

const listWorkflowsMock = vi.mocked(client.listWorkflows)
const createWorkflowMock = vi.mocked(client.createWorkflow)

const sampleWorkflow: client.WorkflowSummary = {
  id: 'w1',
  name: 'Weekly OIB scan',
  description: 'Scan for fire-safety guideline changes',
  enabled: true,
  scheduleCron: '0 6 * * *',
  scheduleTimezone: 'Europe/Vienna',
  nextRunAt: '2026-07-17T06:00:00Z',
  lastRunAt: null,
  updatedAt: '2026-07-16T00:00:00Z',
}

const noop = () => {}

describe('WorkflowList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders workflow cards from the client', async () => {
    listWorkflowsMock.mockResolvedValue([sampleWorkflow])
    render(<WorkflowList projectId="p1" onCreate={noop} onUseTemplate={noop} onEdit={noop} openingId={null} />)

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    // Humanized schedule summary with the timezone.
    expect(screen.getByText(/Daily at 06:00 · Europe\/Vienna/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run now/ })).toBeInTheDocument()
  })

  test('the template gallery is always visible, even with configured workflows', async () => {
    listWorkflowsMock.mockResolvedValue([sampleWorkflow])
    render(<WorkflowList projectId="p1" onCreate={noop} onUseTemplate={noop} onEdit={noop} openingId={null} />)

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-templates')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-templates-placeholder')).toBeInTheDocument()
    expect(screen.getByText('Your workflows')).toBeInTheDocument()
  })

  test('shows the empty state (below the gallery) when there are no workflows', async () => {
    listWorkflowsMock.mockResolvedValue([])
    render(<WorkflowList projectId="p1" onCreate={noop} onUseTemplate={noop} onEdit={noop} openingId={null} />)

    expect(await screen.findByText('No workflows yet')).toBeInTheDocument()
    // The gallery still renders above the empty state.
    expect(screen.getByTestId('workflow-templates')).toBeInTheDocument()
  })

  test('surfaces a retryable error when the list fails to load', async () => {
    listWorkflowsMock.mockRejectedValue(new Error('boom'))
    render(<WorkflowList projectId="p1" onCreate={noop} onUseTemplate={noop} onEdit={noop} openingId={null} />)

    expect(await screen.findByText('The workflows could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('WorkflowBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders the brief form and a live compiled preview', async () => {
    render(
      <WorkflowBuilder projectId="p1" workflow={null} onSaved={noop} onCancel={noop} />,
    )

    expect(screen.getByText('New workflow')).toBeInTheDocument()
    expect(screen.getByText('What the agent receives')).toBeInTheDocument()
    // Data source checkbox loads in.
    expect(await screen.findByText('Web search')).toBeInTheDocument()

    // Typing an objective compiles into the live preview.
    const objective = screen.getByPlaceholderText(/What should the agent research/)
    fireEvent.change(objective, { target: { value: 'Investigate OIB-2' } })

    await waitFor(() => {
      const preview = screen.getByTestId('brief-preview')
      expect(preview.textContent).toContain('# Objective')
      expect(preview.textContent).toContain('Investigate OIB-2')
    })
  })

  test('submitting a valid brief calls createWorkflow', async () => {
    createWorkflowMock.mockResolvedValue({} as client.WorkflowDetail)
    render(<WorkflowBuilder projectId="p1" workflow={null} onSaved={noop} onCancel={noop} />)

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Weekly OIB/), {
      target: { value: 'My workflow' },
    })
    fireEvent.change(screen.getByPlaceholderText(/What should the agent research/), {
      target: { value: 'Investigate OIB-2' },
    })

    const saveButton = screen.getByRole('button', { name: 'Save workflow' })
    // Zod validation may resolve asynchronously — wait until the form is valid.
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createWorkflowMock).toHaveBeenCalledTimes(1))
    const [projectId, payload] = createWorkflowMock.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(payload.name).toBe('My workflow')
    expect(payload.definition.blocks.objective).toBe('Investigate OIB-2')
    // No schedule enabled by default → manual-only.
    expect(payload.scheduleCron).toBeNull()
  })

  test('pre-fills every field (incl. the schedule) from a Piloti template', async () => {
    createWorkflowMock.mockResolvedValue({} as client.WorkflowDetail)
    const t = createTranslator(getDictionary('en'), 'workflows')
    const template = resolveTemplate(t, 'regulatory-watch')
    expect(template).not.toBeNull()

    render(
      <WorkflowBuilder
        projectId="p1"
        workflow={null}
        template={template}
        onSaved={noop}
        onCancel={noop}
      />,
    )

    // Name + objective are seeded from the template content.
    expect(
      await screen.findByDisplayValue('Regulatory watch: OIB & Austrian building law'),
    ).toBeInTheDocument()

    // Saving submits the pre-filled brief, schedule and additional sources —
    // the template only ever pre-fills; the user's save is what creates it.
    const saveButton = screen.getByRole('button', { name: 'Save workflow' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createWorkflowMock).toHaveBeenCalledTimes(1))
    const [, payload] = createWorkflowMock.mock.calls[0]
    expect(payload.definition.blocks.objective).toContain('Austrian building law')
    expect(payload.definition.blocks.questions?.length).toBe(5)
    // Schedule pre-filled ENABLED with the weekly Vienna preset.
    expect(payload.scheduleCron).toBe('0 6 * * 1')
    expect(payload.scheduleTimezone).toBe('Europe/Vienna')
    expect(payload.dataSources).toEqual(['ris', 'web_search'])
  })
})

describe('TemplateCards', () => {
  test('renders every Piloti template with badge, cadence hint and placeholder, and calls onUse', () => {
    const onUse = vi.fn()
    render(<TemplateCards onUse={onUse} />)

    expect(screen.getByText('Submission pre-check')).toBeInTheDocument()
    expect(screen.getByText('Regulatory watch: OIB & Austrian building law')).toBeInTheDocument()
    expect(screen.getByText('OIB compliance gap check')).toBeInTheDocument()
    // Each card carries its provenance category pill.
    expect(screen.getByText('Building law')).toBeInTheDocument()
    expect(screen.getByText('Guidelines')).toBeInTheDocument()
    expect(screen.getByText('Compliance')).toBeInTheDocument()

    // Honest cadence hints derived from the templates' real crons.
    expect(screen.getByText('Runs weekly')).toBeInTheDocument()
    expect(screen.getAllByText('On demand')).toHaveLength(2)

    // The dashed "More coming" placeholder closes the grid.
    expect(screen.getByTestId('workflow-templates-placeholder')).toBeInTheDocument()
    expect(screen.getByText('More workflows coming')).toBeInTheDocument()

    const setUpButtons = screen.getAllByRole('button', { name: /Set up template/ })
    expect(setUpButtons).toHaveLength(3)
    fireEvent.click(setUpButtons[0])
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(onUse.mock.calls[0][0]).toMatchObject({ id: 'submission-precheck' })
  })
})
