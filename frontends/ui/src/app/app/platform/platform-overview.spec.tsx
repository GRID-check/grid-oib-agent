import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { PlatformOverview } from './platform-overview'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Isolate the overview from the heavy WorkOS widget / chart / token machinery —
// what is under test is the fetch lifecycle and the organization directory.
vi.mock('@workos-inc/widgets', () => ({
  WorkOsWidgets: ({ children }: { children: React.ReactNode }) => children,
  UsersManagement: () => <div data-testid="users-management" />,
}))
vi.mock('@/components/charts/spend-trend-chart', () => ({
  SpendTrendChart: () => <div data-testid="spend-trend-chart" />,
}))
vi.mock('@/components/audit/audit-log-button', () => ({
  AuditLogButton: () => <button type="button">Audit logs</button>,
}))
vi.mock('@/lib/workos/widget-token', () => ({
  makeWidgetTokenFetcher: () => async () => 'token',
}))
vi.mock('@/lib/workos/use-widget-appearance', () => ({
  useResolvedAppearance: () => 'light',
  // The component builds the widget's Radix theme from this; a module mock that
  // omits it makes the call site throw rather than render.
  widgetTheme: (appearance: 'light' | 'dark') => ({ appearance }),
}))

const org = (overrides: Partial<Organization> & { id: string; name: string }): Organization => ({
  createdAt: '2026-01-15T00:00:00Z',
  isPlatformOrg: false,
  projectCount: 1,
  dayUsd: 0,
  monthUsd: 0,
  monthEvents: 0,
  ...overrides,
})

interface Organization {
  id: string
  name: string
  createdAt: string
  isPlatformOrg: boolean
  projectCount: number
  dayUsd: number
  monthUsd: number
  monthEvents: number
}

const overview = {
  organizations: [] as Organization[],
  organizationsCapped: false,
  dailyTrend: [],
  totals: { organizations: 3, projects: 7, dayUsd: 1, monthUsd: 2, monthEvents: 42 },
  eurPerUsd: 1,
}

const withOrganizations = (organizations: Organization[], extra: Record<string, unknown> = {}) => ({
  ...overview,
  organizations,
  ...extra,
})

/** 12 organizations, descending month spend — two pages at a page size of 10. */
const MANY = Array.from({ length: 12 }, (_, index) =>
  org({
    id: `org_${index}`,
    name: `Organization ${String(index).padStart(2, '0')}`,
    monthUsd: 120 - index,
    dayUsd: index,
    projectCount: index,
  }),
)

const stubFetch = (payload: unknown) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }))

const directory = () => screen.getByTestId('platform-organizations')

/** Organization names in the order the table renders them. */
const renderedNames = (): string[] =>
  within(directory())
    .getAllByRole('row')
    // Skip the header row; the first cell of each body row holds the name.
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent?.trim() ?? '')

describe('PlatformOverview', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders headline stats on success', async () => {
    stubFetch(overview)

    render(<PlatformOverview />)

    expect(await screen.findByText('3')).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()
    expect(screen.getByTestId('spend-trend-chart')).toBeDefined()
  })

  test('shows a retryable inline error instead of a permanent skeleton on failure', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => overview })
    vi.stubGlobal('fetch', fetchSpy)

    render(<PlatformOverview />)

    expect(await screen.findByText(/Could not load the platform overview/i)).toBeDefined()
    const retry = screen.getByRole('button', { name: /Retry/i })

    await userEvent.click(retry)

    // Recovered: stats render, error is gone.
    expect(await screen.findByText('3')).toBeDefined()
    expect(screen.queryByText(/Could not load the platform overview/i)).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('renders the organization directory as a table, platform org badged', async () => {
    stubFetch(
      withOrganizations([
        org({ id: 'org_1', name: 'GRID Platform', isPlatformOrg: true, projectCount: 4, dayUsd: 3, monthUsd: 90 }),
        org({ id: 'org_2', name: 'Baumeister Wien', projectCount: 2, dayUsd: 1, monthUsd: 10 }),
      ]),
    )

    render(<PlatformOverview />)

    expect(await screen.findByText('GRID Platform')).toBeDefined()
    const table = within(directory())
    expect(table.getByRole('columnheader', { name: /Organization/i })).toBeDefined()
    expect(table.getByRole('columnheader', { name: /This month/i })).toBeDefined()
    expect(table.getByText('Platform')).toBeDefined()
    // EUR conversion + locale currency formatting, not raw USD.
    expect(table.getByText('€90.00')).toBeDefined()
  })

  test('shows the empty state when the platform has no organizations', async () => {
    stubFetch(overview)

    render(<PlatformOverview />)

    expect(await screen.findByText('No organizations yet.')).toBeDefined()
    expect(within(directory()).queryByRole('table')).toBeNull()
  })

  test('filters the directory by name and offers a way back', async () => {
    stubFetch(
      withOrganizations([
        org({ id: 'org_1', name: 'Baumeister Wien' }),
        org({ id: 'org_2', name: 'Ziviltechnik Graz' }),
      ]),
    )

    render(<PlatformOverview />)

    const search = await screen.findByRole('textbox', { name: /Search organizations/i })
    await userEvent.type(search, 'graz')

    expect(renderedNames()).toEqual(['Ziviltechnik Graz'])

    await userEvent.clear(search)
    expect(renderedNames()).toHaveLength(2)
  })

  test('tells the reader when nothing matches instead of showing an empty table', async () => {
    stubFetch(withOrganizations([org({ id: 'org_1', name: 'Baumeister Wien' })]))

    render(<PlatformOverview />)

    const search = await screen.findByRole('textbox', { name: /Search organizations/i })
    await userEvent.type(search, 'nothing here')

    expect(screen.getByText(/No organization matches this search/i)).toBeDefined()
    expect(within(directory()).queryByRole('table')).toBeNull()
  })

  test('sorts by spend, toggling direction on a second click', async () => {
    stubFetch(
      withOrganizations([
        org({ id: 'org_1', name: 'Alpha', monthUsd: 5 }),
        org({ id: 'org_2', name: 'Beta', monthUsd: 50 }),
        org({ id: 'org_3', name: 'Gamma', monthUsd: 20 }),
      ]),
    )

    render(<PlatformOverview />)

    await screen.findByText('Alpha')
    // Biggest month spender first by default, matching the service's own order.
    expect(renderedNames()).toEqual(['Beta', 'Gamma', 'Alpha'])

    const monthHeader = within(directory()).getByRole('button', { name: /Sort by This month/i })
    await userEvent.click(monthHeader)

    expect(renderedNames()).toEqual(['Alpha', 'Gamma', 'Beta'])
    expect(within(directory()).getByRole('columnheader', { name: /This month/i }).getAttribute('aria-sort')).toBe(
      'ascending',
    )
  })

  test('sorts by organization name', async () => {
    stubFetch(
      withOrganizations([
        org({ id: 'org_1', name: 'Zeta', monthUsd: 90 }),
        org({ id: 'org_2', name: 'Alpha', monthUsd: 10 }),
      ]),
    )

    render(<PlatformOverview />)

    await screen.findByText('Alpha')
    await userEvent.click(within(directory()).getByRole('button', { name: /Sort by Organization/i }))

    expect(renderedNames()).toEqual(['Alpha', 'Zeta'])
  })

  test('pages the directory ten rows at a time', async () => {
    stubFetch(withOrganizations(MANY))

    render(<PlatformOverview />)

    await screen.findByText('Organization 00')
    expect(renderedNames()).toHaveLength(10)
    expect(screen.getByText('1–10 of 12')).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /Next/i }))

    expect(renderedNames()).toEqual(['Organization 10', 'Organization 11'])
    expect(screen.getByText('11–12 of 12')).toBeDefined()
  })

  test('returns to the first page when the search changes', async () => {
    stubFetch(withOrganizations(MANY))

    render(<PlatformOverview />)

    await screen.findByText('Organization 00')
    await userEvent.click(screen.getByRole('button', { name: /Next/i }))
    expect(renderedNames()).toEqual(['Organization 10', 'Organization 11'])

    await userEvent.type(screen.getByRole('textbox', { name: /Search organizations/i }), 'Organization')

    expect(renderedNames()[0]).toBe('Organization 00')
  })

  test('says the directory is truncated rather than appending a bare "+"', async () => {
    stubFetch(
      withOrganizations([org({ id: 'org_1', name: 'Baumeister Wien' })], { organizationsCapped: true }),
    )

    render(<PlatformOverview />)

    expect(await screen.findByText(/First 3 — more exist/i)).toBeDefined()
    expect(
      screen.getByText(/Only the first 3 organizations could be loaded from the directory/i),
    ).toBeDefined()
    expect(screen.queryByText('3+')).toBeNull()
  })

  test('keeps the platform team in its own section with its audit trail', async () => {
    stubFetch(overview)

    render(<PlatformOverview />)

    const team = await screen.findByTestId('platform-team')
    expect(within(team).getByTestId('users-management')).toBeDefined()
    expect(within(team).getByRole('button', { name: /Audit logs/i })).toBeDefined()
    // The team widget must not sit inside the organization directory card.
    expect(within(directory()).queryByTestId('users-management')).toBeNull()
  })
})
