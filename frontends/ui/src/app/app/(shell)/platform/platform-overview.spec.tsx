import { act, render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
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
// The price-list card is replaced by a stub that exposes the overview's
// `onSaved` hook, so a test can play "a save just landed" without the card.
const pricingCard = vi.hoisted(() => ({ onSaved: undefined as undefined | (() => void) }))
vi.mock('./platform-pricing-card', () => ({
  PlatformPricingCard: ({ onSaved }: { onSaved?: () => void }) => {
    pricingCard.onSaved = onSaved
    return <div data-testid="platform-pricing" />
  },
}))
vi.mock('@/lib/workos/use-widget-appearance', () => ({
  useResolvedAppearance: () => 'light',
  // The component builds the widget's Radix theme from this; a module mock that
  // omits it makes the call site throw rather than render.
  widgetTheme: (appearance: 'light' | 'dark') => ({ appearance }),
}))

/** USD cost as charged, priced at a 2× margin with one credit = $0.10. */
const spend = (costUsd: number, events = Math.round(costUsd)) => ({
  costUsd,
  ownKeyCostUsd: 0,
  priceUsd: costUsd * 2,
  credits: costUsd * 20,
  tokens: costUsd * 1000,
  events,
})

const org = (
  overrides: Partial<Organization> & {
    id: string
    name: string
    dayUsd?: number
    monthUsd?: number
  }
): Organization => {
  const { dayUsd = 0, monthUsd = 0, ...rest } = overrides
  return {
    createdAt: '2026-01-15T00:00:00Z',
    isPlatformOrg: false,
    projectCount: 1,
    day: spend(dayUsd),
    month: spend(monthUsd),
    ...rest,
  }
}

interface SpendWindow {
  costUsd: number
  ownKeyCostUsd: number
  priceUsd: number
  credits: number
  tokens: number
  events: number
  ingestCostUsd?: number
  dictationCostUsd?: number
}

interface Organization {
  id: string
  name: string
  createdAt: string
  isPlatformOrg: boolean
  projectCount: number
  day: SpendWindow
  month: SpendWindow
}

const overview = {
  organizations: [] as Organization[],
  organizationsCapped: false,
  dailyTrend: [],
  totals: { organizations: 3, projects: 7, day: spend(1, 4), month: spend(2, 42) },
  pricing: { marginMultiplier: 2, usdPerCredit: 0.1, explicit: true },
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
  })
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
    .map(
      (row) =>
        within(row).getAllByRole('cell')[0].querySelector('.truncate')?.textContent?.trim() ?? ''
    )

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

  test('opens the selected organization allowance from the directory', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          withOrganizations([
            org({ id: 'org_1', name: 'Office One' }),
            org({ id: 'org_2', name: 'Office Two' }),
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          organizationId: 'org_2',
          unit: 'credit',
          dailyLimit: 1000,
          monthlyLimit: 25000,
          explicit: true,
          dayUsed: 0,
          monthUsed: 0,
          canManage: true,
        }),
      })
    vi.stubGlobal('fetch', fetchSpy)
    render(<PlatformOverview />)
    // The wide column's button and the narrow layout's link are the same action;
    // CSS shows one of them per container width.
    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'Edit allowance for Office Two' }))[0]
    )
    expect(await screen.findByLabelText('Monthly allowance (credits)')).toHaveValue('25000')
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Allowance for Office Two')
    expect(fetchSpy).toHaveBeenLastCalledWith('/api/platform/organizations/org_2/budgets', {
      credentials: 'same-origin',
    })
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
        org({
          id: 'org_1',
          name: 'GRID Platform',
          isPlatformOrg: true,
          projectCount: 4,
          dayUsd: 3,
          monthUsd: 90,
        }),
        org({ id: 'org_2', name: 'Baumeister Wien', projectCount: 2, dayUsd: 1, monthUsd: 10 }),
      ])
    )

    render(<PlatformOverview />)

    expect(await screen.findByText('GRID Platform')).toBeDefined()
    const table = within(directory())
    expect(table.getByRole('columnheader', { name: /Organization/i })).toBeDefined()
    expect(table.getByRole('columnheader', { name: /Cost this month/i })).toBeDefined()
    expect(table.getByText('Platform')).toBeDefined()
    // EUR conversion + locale currency formatting, not raw USD.
    // Cost as charged and revenue at the price list, side by side.
    expect(table.getByText('$90.00')).toBeDefined()
    expect(table.getByText('$180.00')).toBeDefined()
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
      ])
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
      ])
    )

    render(<PlatformOverview />)

    await screen.findByText('Alpha')
    // Biggest month spender first by default, matching the service's own order.
    expect(renderedNames()).toEqual(['Beta', 'Gamma', 'Alpha'])

    // The default sort is revenue; the cost column starts descending on its
    // first click and flips on the second.
    const monthHeader = within(directory()).getByRole('button', {
      name: /Sort by Cost this month/i,
    })
    await userEvent.click(monthHeader)
    expect(renderedNames()).toEqual(['Beta', 'Gamma', 'Alpha'])
    await userEvent.click(monthHeader)

    expect(renderedNames()).toEqual(['Alpha', 'Gamma', 'Beta'])
    expect(
      within(directory())
        .getByRole('columnheader', { name: /Cost this month/i })
        .getAttribute('aria-sort')
    ).toBe('ascending')
  })

  test('sorts by organization name', async () => {
    stubFetch(
      withOrganizations([
        org({ id: 'org_1', name: 'Zeta', monthUsd: 90 }),
        org({ id: 'org_2', name: 'Alpha', monthUsd: 10 }),
      ])
    )

    render(<PlatformOverview />)

    await screen.findByText('Alpha')
    await userEvent.click(
      within(directory()).getByRole('button', { name: /Sort by Organization/i })
    )

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

    await userEvent.type(
      screen.getByRole('textbox', { name: /Search organizations/i }),
      'Organization'
    )

    expect(renderedNames()[0]).toBe('Organization 00')
  })

  test('says the directory is truncated rather than appending a bare "+"', async () => {
    stubFetch(
      withOrganizations([org({ id: 'org_1', name: 'Baumeister Wien' })], {
        organizationsCapped: true,
      })
    )

    render(<PlatformOverview />)

    // Said once, on the tile, and not again in a footer under the directory.
    expect(await screen.findByText('Only the first 3 loaded, more exist')).toBeDefined()
    expect(screen.getAllByText(/Only the first 3/)).toHaveLength(1)
    expect(screen.queryByText('3+')).toBeNull()

    // The search repeats it only to explain a miss.
    await userEvent.type(screen.getByRole('textbox', { name: /Search organizations/i }), 'nowhere')
    expect(
      screen.getByText(/Only the first 3 organizations are loaded, so it may be among the rest/)
    ).toBeDefined()
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

  test('shows what ingestion cost, per organization and within the headline cost', async () => {
    const ingesting = org({ id: 'org_1', name: 'Baumeister Wien', monthUsd: 40 })
    ingesting.month.ingestCostUsd = 12.5
    stubFetch(
      withOrganizations([ingesting, org({ id: 'org_2', name: 'Ohne Upload', monthUsd: 5 })], {
        totals: {
          ...overview.totals,
          day: spend(1, 4),
          month: { ...spend(45, 42), ingestCostUsd: 12.5 },
        },
      })
    )

    render(<PlatformOverview />)

    const table = within(await screen.findByTestId('platform-organizations'))
    // Under the organization's month cost, rather than a column of mostly zeros.
    expect(table.getByText('of which ingestion $12.50')).toBeDefined()
    // Part of the month's cost, not on top of it; today had none, so no hint.
    const kpis = within(screen.getByTestId('platform-kpis'))
    expect(kpis.getByText(/of which ingestion \$12\.50/)).toBeDefined()
    expect(kpis.getAllByText(/of which ingestion/)).toHaveLength(1)
  })

  test('shows what voice dictation cost within the headline cost, beside ingestion', async () => {
    stubFetch(
      withOrganizations([org({ id: 'org_1', name: 'Baumeister Wien', monthUsd: 40 })], {
        totals: {
          ...overview.totals,
          day: { ...spend(1, 4), dictationCostUsd: 0.25 },
          month: { ...spend(45, 42), ingestCostUsd: 12.5, dictationCostUsd: 1.75 },
        },
      })
    )

    render(<PlatformOverview />)

    await screen.findByTestId('platform-organizations')
    expect(screen.getByText('of which voice input $0.25')).toBeDefined()
    expect(
      screen.getByText(/of which ingestion \$12\.50 · of which voice input \$1\.75/)
    ).toBeDefined()
  })

  test('reloads after a price-list save in place: no skeleton, the card stays mounted', async () => {
    let resolveReload: (value: unknown) => void = () => undefined
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => overview })
      .mockReturnValueOnce(new Promise((resolve) => (resolveReload = resolve)))
    vi.stubGlobal('fetch', fetchSpy)

    render(<PlatformOverview />)
    await screen.findByTestId('platform-kpis')
    const card = screen.getByTestId('platform-pricing')

    act(() => pricingCard.onSaved?.())

    // While the reload is in flight the figures and the card stay put. The old
    // code swapped the whole tree for skeletons, unmounting the card that had
    // just called this.
    expect(screen.queryByTestId('platform-overview-loading')).toBeNull()
    expect(screen.getByTestId('platform-pricing')).toBe(card)
    expect(screen.getByTestId('platform-overview')).toHaveAttribute('aria-busy', 'true')

    await act(async () =>
      resolveReload({
        ok: true,
        json: async () => ({ ...overview, totals: { ...overview.totals, projects: 9 } }),
      })
    )
    expect(await screen.findByText('9')).toBeDefined()
    expect(screen.getByTestId('platform-pricing')).toBe(card)
  })

  test('a failed reload says the figures may be stale instead of keeping them silently', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => overview })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => overview })
    vi.stubGlobal('fetch', fetchSpy)

    render(<PlatformOverview />)
    await screen.findByTestId('platform-kpis')
    act(() => pricingCard.onSaved?.())

    const stale = await screen.findByTestId('platform-overview-stale')
    expect(stale).toHaveTextContent(
      'Could not refresh the overview. The figures shown may be out of date.'
    )
    // The figures are still there under the warning.
    expect(screen.getByText('7')).toBeDefined()

    await userEvent.click(within(stale).getByRole('button', { name: /Retry/i }))
    await waitFor(() => expect(screen.queryByTestId('platform-overview-stale')).toBeNull())
  })

  test('the month request count is in the hint, readable without a hover', async () => {
    stubFetch({ ...overview, totals: { ...overview.totals, month: spend(2, 4200) } })

    render(<PlatformOverview />)

    expect(await screen.findByText('4,200 requests')).toBeDefined()
  })

  test('counts are locale-formatted and a sub-cent cost is not shown as free', async () => {
    stubFetch({
      ...overview,
      totals: { ...overview.totals, organizations: 1200, projects: 12345, day: spend(0.004, 1) },
    })

    render(<PlatformOverview />)

    expect(await screen.findByText('1,200')).toBeDefined()
    expect(screen.getByText('12,345')).toBeDefined()
    expect(screen.getByText('< $0.01')).toBeDefined()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  test('read-only staff open an allowance to view it, not to edit it', async () => {
    stubFetch(withOrganizations([org({ id: 'org_1', name: 'Office One' })]))

    render(
      <PlatformAccessProvider
        permissions={[PLATFORM_PERMISSIONS.organizationsView, PLATFORM_PERMISSIONS.usageView]}
      >
        <PlatformOverview />
      </PlatformAccessProvider>
    )

    expect(
      (await screen.findAllByRole('button', { name: 'View allowance for Office One' })).length
    ).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Edit allowance for Office One' })).toBeNull()
  })
})
