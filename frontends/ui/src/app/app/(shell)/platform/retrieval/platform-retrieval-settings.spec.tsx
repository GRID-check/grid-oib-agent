import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { parseSettingValue, PlatformRetrievalSettings } from './platform-retrieval-settings'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body }) as Response

const PAYLOAD = {
  definitions: [
    {
      key: 'knowledge.top_k',
      defaultValue: 10,
      min: 1,
      max: 50,
      label: 'Knowledge hits',
      description: 'Chunks per search.',
    },
  ],
  settings: [
    {
      key: 'knowledge.top_k',
      value: 10,
      defaultValue: 10,
      overridden: false,
      updatedByEmail: null,
      updatedAt: null,
    },
  ],
}

const fetchMock = vi.fn()

describe('PlatformRetrievalSettings', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({}) : json(PAYLOAD)
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  test('a cleared number field stays empty, says why, and blocks Save', async () => {
    render(<PlatformRetrievalSettings />)
    const field = await screen.findByLabelText('Knowledge hits')

    await userEvent.clear(field)
    // Before: the empty field snapped straight back to the default (10).
    expect(field).toHaveValue('')
    expect(screen.getByRole('alert').textContent).toContain('A whole number from 1 to 50')
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled()

    await userEvent.type(field, '25')
    expect(field).toHaveValue('25')
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })

  test('the range is visible next to the field, not only in a tooltip', async () => {
    render(<PlatformRetrievalSettings />)
    const row = await screen.findByTestId('retrieval-row-knowledge.top_k')
    expect(within(row).getByText('1–50 · Default 10')).toBeInTheDocument()
  })

  test('a save refreshes without collapsing the rows into skeletons', async () => {
    render(<PlatformRetrievalSettings />)
    const field = await screen.findByLabelText('Knowledge hits')
    await userEvent.clear(field)
    await userEvent.type(field, '20')
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Change settings' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(screen.queryByTestId('section-loading')).toBeNull()
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body)).settings).toEqual({ 'knowledge.top_k': 20 })
  })

  test('shows an empty state when the catalog has no settings', async () => {
    fetchMock.mockResolvedValue(json({ definitions: [], settings: [] }))
    render(<PlatformRetrievalSettings />)
    expect(await screen.findByText('No retrieval settings')).toBeInTheDocument()
  })

  test('read-only staff get disabled fields and no save', async () => {
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <PlatformRetrievalSettings />
      </PlatformAccessProvider>
    )
    expect(await screen.findByLabelText('Knowledge hits')).toBeDisabled()
    expect(screen.getByText(/do not have permission to change them/)).toBeInTheDocument()
  })
})

describe('parseSettingValue', () => {
  const range = { min: 1, max: 50 }
  test.each([
    ['', null],
    ['  ', null],
    ['0', null],
    ['51', null],
    ['2.5', null],
    ['abc', null],
    ['07', 7],
    [' 25 ', 25],
  ])('%j → %j', (raw, expected) => {
    expect(parseSettingValue(raw, range)).toBe(expected)
  })

  test('respects allowed values', () => {
    expect(parseSettingValue('3', { min: 0, max: 10, allowedValues: [0, 5, 10] })).toBeNull()
    expect(parseSettingValue('5', { min: 0, max: 10, allowedValues: [0, 5, 10] })).toBe(5)
  })
})
