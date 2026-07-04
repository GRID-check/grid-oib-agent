import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProjectOverview } from './project-overview'
import type { ProjectOverviewData } from '../types'

const mockData: ProjectOverviewData = {
  id: 'proj-1',
  name: 'Test Project',
  collectionName: 'proj-1-collection',
  createdAt: '2026-01-01T00:00:00.000Z',
  profileDisplay: null,
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

  it('renders key facts when profile display exists', () => {
    const dataWithProfile = {
      ...mockData,
      profileDisplay: {
        title: 'Test',
        summary: 'A test project',
        keyFacts: [
          { label: 'Type', value: 'Residential' },
          { label: 'Location', value: 'Berlin' },
        ],
      },
    }
    render(<ProjectOverview data={dataWithProfile} />)
    expect(screen.getByText('Residential')).toBeDefined()
    expect(screen.getByText('Berlin')).toBeDefined()
  })
})
