import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { PlatformModelDefaults } from './platform-model-defaults'

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

const json = (body: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
    clone: () => json(body, status),
  }) as Response

const DEFAULTS = {
  agentGroups: [
    { id: 'follow_ups', label: 'Follow-up questions', description: 'Suggests the next question.' },
    { id: 'clarifier', label: 'Clarifier', description: 'Asks back.' },
  ],
  defaults: {
    follow_ups: {
      model: 'vendor/fast',
      updatedByEmail: null,
      updatedAt: '2026-07-28T09:00:00Z',
      zdrSafe: true,
    },
  },
  workflowDefaults: { follow_ups: 'vendor/yaml', clarifier: 'vendor/yaml' },
  workflowDefaultsZdrSafe: { follow_ups: true, clarifier: true },
}

const EFFORTS = { efforts: {}, workflowEfforts: { follow_ups: 'none', clarifier: 'medium' } }

const fetchMock = vi.fn()

function route(putStatus: number): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/platform/model-defaults' && init?.method === 'PUT') return json({}, putStatus)
    if (url === '/api/platform/model-defaults') return json(DEFAULTS)
    if (url === '/api/platform/reasoning-efforts') return json(EFFORTS)
    throw new Error(`unexpected ${url}`)
  })
}

const getCalls = (): number =>
  fetchMock.mock.calls.filter(
    ([url, init]) => url === '/api/platform/model-defaults' && !init?.method
  ).length

describe('PlatformModelDefaults', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  test('a failed save keeps the draft on screen instead of reloading over it', async () => {
    route(500)
    render(<PlatformModelDefaults />)

    const row = await screen.findByTestId('model-row-follow_ups')
    await userEvent.click(within(row).getByRole('button', { name: /Back to the workflow config/ }))
    expect(within(row).getByText('Changed')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Change defaults' }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // The reset pick survives: the row still shows the workflow model, still
    // flagged as changed, and the save bar is still there to retry.
    expect(within(row).getByText('vendor/yaml')).toBeInTheDocument()
    expect(within(row).getByText('Changed')).toBeInTheDocument()
    expect(screen.getByTestId('model-save-bar')).toBeInTheDocument()
    // Nothing re-read the server over the draft.
    expect(getCalls()).toBe(1)
  })

  test('a successful save refreshes without collapsing the rows into skeletons', async () => {
    route(200)
    render(<PlatformModelDefaults />)

    const row = await screen.findByTestId('model-row-follow_ups')
    await userEvent.click(within(row).getByRole('button', { name: /Back to the workflow config/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Change defaults' }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    await waitFor(() => expect(getCalls()).toBe(2))
    expect(screen.queryByTestId('section-loading')).toBeNull()
    expect(screen.getByTestId('model-row-follow_ups')).toBeInTheDocument()
  })

  test('the inherited thinking level is named, not shown as the raw enum', async () => {
    route(200)
    render(<PlatformModelDefaults />)

    const row = await screen.findByTestId('model-row-follow_ups')
    expect(within(row).getByRole('combobox').textContent).toContain('Workflow: Off')
  })

  test('read-only staff see the defaults without any write control', async () => {
    route(200)
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <PlatformModelDefaults />
      </PlatformAccessProvider>
    )

    const row = await screen.findByTestId('model-row-follow_ups')
    expect(screen.getByText(/do not have permission to change them/)).toBeInTheDocument()
    expect(within(row).getByText('vendor/fast')).toBeInTheDocument()
    expect(within(row).queryByRole('button')).toBeNull()
    expect(within(row).getByRole('combobox')).toBeDisabled()
  })
})
