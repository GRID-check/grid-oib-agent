import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { PlatformOrgBudgetDialog } from './platform-org-budget-dialog'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const budget = {
  organizationId: 'org_tenant',
  unit: 'credit',
  dailyLimit: 1000,
  monthlyLimit: 10000,
  explicit: false,
  dayUsed: 25,
  monthUsed: 300,
  canManage: true,
}
const organization = { id: 'org_tenant', name: 'Planning Office' }
const onClose = vi.fn()
const response = (body: unknown, status = 200) => Response.json(body, { status })
const fetchMock = vi.fn()

describe('platform organization allowance editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(response(budget))
  })

  it('loads the selected org allowance and current usage without writing', async () => {
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    expect(await screen.findByLabelText('Monthly allowance (credits)')).toHaveValue('10000')
    expect(screen.getByLabelText('Daily limit (credits)')).toHaveValue('1000')
    expect(screen.getByText('Default allowance')).toBeDefined()
    expect(screen.getByText('Used today: 25 credits. This month: 300 credits.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledWith('/api/platform/organizations/org_tenant/budgets', { credentials: 'same-origin' })
  })

  it('can pin the default allowance as a per-org custom allowance without changing its amount', async () => {
    fetchMock.mockResolvedValueOnce(response(budget)).mockResolvedValueOnce(response({ ...budget, explicit: true }))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    await screen.findByLabelText('Monthly allowance (credits)')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ dailyLimit: 1000, monthlyLimit: 10000 })
  })

  it('does not create another policy when a custom allowance has not changed', async () => {
    fetchMock.mockResolvedValue(response({ ...budget, explicit: true }))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    await screen.findByLabelText('Monthly allowance (credits)')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves a different monthly allowance for this org, preserving its daily limit', async () => {
    fetchMock.mockResolvedValueOnce(response(budget)).mockResolvedValueOnce(response({ ...budget, monthlyLimit: 25000 }))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    const monthly = await screen.findByLabelText('Monthly allowance (credits)')
    await userEvent.clear(monthly)
    await userEvent.type(monthly, '25000')
    await userEvent.type(screen.getByLabelText('Change note (optional)'), 'Pilot plan')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenLastCalledWith('/api/platform/organizations/org_tenant/budgets', {
      credentials: 'same-origin',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit: 'credit', dailyLimit: 1000, monthlyLimit: 25000, note: 'Pilot plan' }),
    })
  })

  it('sends blank as unlimited and zero as a blocking allowance', async () => {
    fetchMock.mockResolvedValueOnce(response(budget)).mockResolvedValueOnce(response(budget))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    await userEvent.clear(await screen.findByLabelText('Monthly allowance (credits)'))
    const daily = screen.getByLabelText('Daily limit (credits)')
    await userEvent.clear(daily)
    await userEvent.type(daily, '0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ dailyLimit: 0, monthlyLimit: null })
  })

  it.each(['oops', '-1', '12oops', '100000000'])('does not silently save invalid input %s as unlimited', async (value) => {
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    const monthly = await screen.findByLabelText('Monthly allowance (credits)')
    await userEvent.clear(monthly)
    await userEvent.type(monthly, value)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('provides read-only support with no write controls', async () => {
    fetchMock.mockResolvedValue(response({ ...budget, explicit: true, canManage: false }))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    expect(await screen.findByLabelText('Monthly allowance (credits)')).toBeDisabled()
    expect(screen.getByText('Custom allowance')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByLabelText('Change note (optional)')).toBeNull()
  })

  it('lets a failed load be retried', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response(budget))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Monthly allowance (credits)')).toHaveValue('10000')
  })

  it('keeps the draft open and reports a failed save', async () => {
    fetchMock.mockResolvedValueOnce(response(budget)).mockResolvedValueOnce(response({}, 500))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    const monthly = await screen.findByLabelText('Monthly allowance (credits)')
    await userEvent.clear(monthly)
    await userEvent.type(monthly, '20000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the organization allowance.'))
    expect(onClose).not.toHaveBeenCalled()
    expect(monthly).toHaveValue('20000')
  })

  it('explains a stale unit conflict without closing or reporting success', async () => {
    fetchMock.mockResolvedValueOnce(response(budget)).mockResolvedValueOnce(response({}, 409))
    render(<PlatformOrgBudgetDialog organization={organization} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText('Monthly allowance (credits)'), '0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('changed its budget unit')))
    expect(onClose).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
