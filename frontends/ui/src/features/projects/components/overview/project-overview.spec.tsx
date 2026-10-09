import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import type { ProjectOverviewData } from '../../types'
import type { ProjectUsageView } from '../settings/usage-settings'
import { ProjectOverview } from './project-overview'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const DATA: ProjectOverviewData = {
  id: 'p1',
  name: 'Alpine Tower',
  collectionName: 'proj_1',
  createdAt: '2026-07-01T10:00:00Z',
  profileDisplay: { summary: 'Wohnbau GK4 in Wien.' },
  profile: null,
  applicableStandards: [],
  briefComplete: false,
  documentCount: 12,
  totalFileSize: 48_000_000,
  recentDocuments: [
    {
      id: 'd1',
      filename: 'Einreichplan.pdf',
      fileSize: 100,
      contentType: 'application/pdf',
      status: 'ready',
      createdAt: new Date('2026-10-01T10:00:00Z'),
    },
  ],
}

const USAGE: ProjectUsageView = {
  unit: 'credit',
  day: { amount: 4, events: 2 },
  month: { amount: 120, events: 40 },
  perModel: [],
  projectLimit: null,
  orgLimit: { dailyLimit: null, monthlyLimit: 1000 },
  blockedScope: null,
  dailyTrend: [],
}

const VIEWER = { manage: false, editProfile: false, manageMembers: false }
const ADMIN = { manage: true, editProfile: true, manageMembers: true }

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('/memory')) {
      return Response.json({
        items: [
          { id: 'm1', content: 'Sichtbeton Nordfassade', pinned: true, verification: 'user_confirmed' },
          { id: 'm2', content: 'Tiefgarage geplant', pinned: false, verification: 'unverified' },
        ],
      })
    }
    if (url.endsWith('/members')) {
      return Response.json({
        members: [
          { userId: 'u1', name: 'Anna Berger', profilePictureUrl: null, role: 'project-admin' },
          { userId: 'u2', name: 'Markus Klein', profilePictureUrl: null, role: null },
        ],
      })
    }
    return Response.json({})
  })
})

afterEach(() => vi.restoreAllMocks())

describe('ProjectOverview', () => {
  test('the hero carries the project and the ways into it', () => {
    render(<ProjectOverview data={DATA} usage={null} access={VIEWER} />)

    const hero = screen.getByTestId('overview-hero')
    expect(within(hero).getByText('Alpine Tower')).toBeInTheDocument()
    expect(within(hero).getByText('Wohnbau GK4 in Wien.')).toBeInTheDocument()
    expect(within(hero).getByRole('link', { name: /Ask Piloti/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/chat?new=1'
    )
  })

  test('a viewer gets no project menu, no briefing editor, no spend and no roster', () => {
    render(<ProjectOverview data={DATA} usage={null} access={VIEWER} />)

    expect(screen.queryByRole('button', { name: 'Project actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Edit briefing/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('overview-usage')).not.toBeInTheDocument()
    expect(screen.queryByTestId('overview-members')).not.toBeInTheDocument()
  })

  test('an admin gets the menu, the spend and the roster', async () => {
    render(<ProjectOverview data={DATA} usage={USAGE} access={ADMIN} />)

    expect(screen.getByRole('button', { name: 'Project actions' })).toBeInTheDocument()
    expect(screen.getByTestId('overview-usage')).toHaveTextContent('120 credits')
    // Only people with a project role are counted, not the whole org roster.
    const members = screen.getByTestId('overview-members')
    expect(await within(members).findByText('person')).toBeInTheDocument()
  })

  test('the memory tile counts notes and what is left to review', async () => {
    render(<ProjectOverview data={DATA} usage={null} access={VIEWER} />)

    const memory = screen.getByTestId('overview-memory')
    expect(await within(memory).findByText('1 to review')).toBeInTheDocument()
    expect(within(memory).getByText('Sichtbeton Nordfassade')).toBeInTheDocument()
  })

  test('every tile opens its section', () => {
    render(<ProjectOverview data={DATA} usage={USAGE} access={ADMIN} />)

    expect(screen.getByRole('link', { name: /Usage & budget/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/settings/usage'
    )
    expect(screen.getByRole('link', { name: /Documents & index/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/settings/documents'
    )
  })
})
