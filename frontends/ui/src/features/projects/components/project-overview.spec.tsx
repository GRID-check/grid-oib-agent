import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProjectOverview } from './project-overview'
import type { ProjectOverviewData } from '../types'

// ProjectOverview renders ProjectDangerZone, which calls useRouter().
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

const mockData: ProjectOverviewData = {
  id: 'proj-1',
  name: 'Test Project',
  collectionName: 'proj-1-collection',
  createdAt: '2026-01-01T00:00:00.000Z',
  profileDisplay: null,
  profile: null,
  applicableStandards: [],
  briefComplete: false,
  documentCount: 0,
  totalFileSize: 0,
  recentDocuments: [],
}

describe('ProjectOverview', () => {
  it('renders project name', () => {
    render(<ProjectOverview data={mockData} />)
    expect(screen.getByText('Test Project')).toBeDefined()
  })

  it('shows setup prompt when no profile exists', () => {
    render(<ProjectOverview data={mockData} />)
    expect(screen.getByText(/Set up the project brief/i)).toBeDefined()
  })

  it('never renders a blank brief: profile present but no key facts still guides the user', () => {
    const dataWithEmptyProfile = {
      ...mockData,
      profileDisplay: { title: 'Project profile', summary: '', keyFacts: [], missingInfo: [] },
    }
    render(<ProjectOverview data={dataWithEmptyProfile} />)
    // The Applicable Standards panel also mentions the project brief, so match
    // the section heading specifically rather than any text occurrence.
    expect(screen.getByRole('heading', { name: /Project Brief/i })).toBeDefined()
    expect(screen.getByText(/no details are captured yet/i)).toBeDefined()
  })

  it('shows file count', () => {
    render(<ProjectOverview data={{ ...mockData, documentCount: 5 }} />)
    expect(screen.getByText('5')).toBeDefined()
  })

  it('shows empty state when no documents', () => {
    render(<ProjectOverview data={mockData} />)
    expect(screen.getByText(/No files yet/i)).toBeDefined()
  })

  it('hides the danger zone from users who cannot delete (default)', () => {
    render(<ProjectOverview data={mockData} />)
    expect(screen.queryByRole('heading', { name: /Danger zone/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete project/i })).toBeNull()
  })

  it('renders the danger zone only when the user can manage the project', () => {
    render(<ProjectOverview data={mockData} canManageProject />)
    expect(screen.getByRole('heading', { name: /Danger zone/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /Delete project/i })).toBeDefined()
  })

  it('hides the rename affordance from users who cannot manage the project', () => {
    render(<ProjectOverview data={mockData} />)
    expect(screen.queryByRole('button', { name: /Rename project/i })).toBeNull()
  })

  it('offers a rename affordance to users who can manage the project', () => {
    render(<ProjectOverview data={mockData} canManageProject />)
    expect(screen.getByRole('button', { name: /Rename project/i })).toBeDefined()
  })

  it('renders grouped, human-labelled facts from the raw profile', () => {
    const dataWithProfile: ProjectOverviewData = {
      ...mockData,
      profileDisplay: { title: 'Test', summary: 'A test project', keyFacts: [], missingInfo: [] },
      profile: {
        facts: {
          hauptnutzung: {
            value: 'wohnen',
            confidence: 'confirmed',
            source: 'onboarding',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          gebaeudeklasse: {
            value: 'GK4',
            confidence: 'confirmed',
            source: 'onboarding',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        goals: {},
        unknowns: ['fluchtniveau'],
        assumptions: {},
      },
    }
    render(<ProjectOverview data={dataWithProfile} />)
    expect(screen.getByText('A test project')).toBeDefined()
    // Intake labels, not raw keys/enum values.
    expect(screen.getByText('Main use')).toBeDefined()
    expect(screen.getByText('Residential')).toBeDefined()
    expect(screen.getByText('GK4')).toBeDefined()
    // The open unknown links back into the wizard.
    expect(screen.getByRole('link', { name: 'Escape level' })).toBeDefined()
  })

  it('offers confirm/dismiss for agent-suggested assumptions', () => {
    const dataWithAssumption: ProjectOverviewData = {
      ...mockData,
      profileDisplay: { title: 'Test', summary: '', keyFacts: [], missingInfo: [] },
      profile: {
        facts: {},
        goals: {},
        unknowns: [],
        assumptions: {
          widmung: {
            value: 'bauland',
            status: 'unconfirmed',
            reason: 'Suggested from the uploaded development plan.',
            source: 'agent_suggested',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }
    render(<ProjectOverview data={dataWithAssumption} />)
    expect(screen.getByText('Building land (Bauland)')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined()
  })
})
