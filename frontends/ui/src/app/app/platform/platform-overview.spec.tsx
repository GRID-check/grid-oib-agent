import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { PlatformOverview } from './platform-overview'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Isolate the overview from the heavy WorkOS widget / chart / token machinery —
// the behaviour under test is the load/error/retry lifecycle.
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
}))

const overview = {
  organizations: [],
  organizationsCapped: false,
  dailyTrend: [],
  totals: { organizations: 3, projects: 7, dayUsd: 1, monthUsd: 2, monthEvents: 42 },
  eurPerUsd: 1,
}

describe('PlatformOverview', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders headline stats on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => overview }))

    render(<PlatformOverview />)

    expect(await screen.findByText('3')).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()
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
})
