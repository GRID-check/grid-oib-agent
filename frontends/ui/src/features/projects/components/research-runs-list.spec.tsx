import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@/test-utils'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ResearchRunsList } from './research-runs-list'
import type { ResearchRun } from '@/adapters/api/research-runs-client'

const listResearchRuns = vi.fn()
const listConversations = vi.fn()

vi.mock('@/adapters/api/research-runs-client', () => ({
  listResearchRuns: (...args: unknown[]) => listResearchRuns(...args),
}))

vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: {
    list: (...args: unknown[]) => listConversations(...args),
  },
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

const makeRun = (overrides: Partial<ResearchRun>): ResearchRun => ({
  job_id: 'abcdef1234567890',
  status: 'completed',
  created_at: new Date().toISOString(),
  conversation_id: null,
  project_collection: 'proj_1',
  ...overrides,
})

describe('ResearchRunsList', () => {
  beforeEach(() => {
    listResearchRuns.mockReset()
    listConversations.mockReset()
    listConversations.mockResolvedValue([])
  })

  test('renders a crafted empty state pointing to Chat', async () => {
    listResearchRuns.mockResolvedValue({ jobs: [], total: 0 })
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText(/No research runs yet/i)).toBeDefined()
    const cta = screen.getByRole('link', { name: /Start a run in Chat/i })
    expect(cta.getAttribute('href')).toBe('/app/projects/p1/chat')
  })

  test('shows a View report link to the chat job for completed runs', async () => {
    listResearchRuns.mockResolvedValue({ jobs: [makeRun({ job_id: 'job-123456789' })], total: 1 })
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    const link = await screen.findByRole('link', { name: /View report/i })
    expect(link.getAttribute('href')).toBe('/app/projects/p1/chat?job=job-123456789')
    // short job id is surfaced in mono
    expect(screen.getByText('job-1234')).toBeDefined()
  })

  test('does not offer a report link for non-completed runs', async () => {
    listResearchRuns.mockResolvedValue({ jobs: [makeRun({ status: 'running' })], total: 1 })
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText(/Report pending/i)).toBeDefined()
    expect(screen.queryByRole('link', { name: /View report/i })).toBeNull()
  })

  test('labels a run with its originating session title when resolvable', async () => {
    listResearchRuns.mockResolvedValue({
      jobs: [makeRun({ job_id: 'job-abcdef99', conversation_id: 'conv-1' })],
      total: 1,
    })
    listConversations.mockResolvedValue([
      { id: 'conv-1', title: 'Fire safety for staircases', createdAt: '', updatedAt: '' },
    ])
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText('Fire safety for staircases')).toBeDefined()
    // job-id hash is demoted to metadata, still visible
    expect(screen.getByText('job-abcd')).toBeDefined()
  })

  test('falls back to a session label when the run has no resolvable title', async () => {
    listResearchRuns.mockResolvedValue({
      jobs: [makeRun({ job_id: 'job-abcdef99', conversation_id: 'conv-xyz12345' })],
      total: 1,
    })
    listConversations.mockResolvedValue([])
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    // sessionLabel interpolates the short conversation id
    expect(await screen.findByText(/Session conv-xyz/i)).toBeDefined()
  })

  test('deep-links failed runs to the chat thinking view', async () => {
    listResearchRuns.mockResolvedValue({
      jobs: [makeRun({ job_id: 'job-failed-1', status: 'failed' })],
      total: 1,
    })
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    const link = await screen.findByRole('link', { name: /View thinking/i })
    expect(link.getAttribute('href')).toBe('/app/projects/p1/chat?job=job-failed-1&tab=thinking')
  })

  test('surfaces load failures with a retry affordance', async () => {
    listResearchRuns.mockRejectedValue(new Error('boom'))
    render(<ResearchRunsList projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText(/Couldn't load research runs/i)).toBeDefined()
    await waitFor(() => expect(screen.getByRole('button', { name: /Try again/i })).toBeDefined())
  })
})
