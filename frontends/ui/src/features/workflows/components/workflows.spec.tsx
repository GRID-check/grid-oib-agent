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

import * as client from '@/adapters/api/workflows-client'
import { WorkflowList } from './workflow-list'
import { WorkflowBuilder } from './workflow-builder'

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
    render(<WorkflowList projectId="p1" onCreate={noop} onEdit={noop} openingId={null} />)

    expect(await screen.findByText('Weekly OIB scan')).toBeInTheDocument()
    // Humanized schedule summary with the timezone.
    expect(screen.getByText(/Daily at 06:00 · Europe\/Vienna/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run now/ })).toBeInTheDocument()
  })

  test('shows the empty state when there are no workflows', async () => {
    listWorkflowsMock.mockResolvedValue([])
    render(<WorkflowList projectId="p1" onCreate={noop} onEdit={noop} openingId={null} />)

    expect(await screen.findByText('No workflows yet')).toBeInTheDocument()
  })

  test('surfaces a retryable error when the list fails to load', async () => {
    listWorkflowsMock.mockRejectedValue(new Error('boom'))
    render(<WorkflowList projectId="p1" onCreate={noop} onEdit={noop} openingId={null} />)

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
})
