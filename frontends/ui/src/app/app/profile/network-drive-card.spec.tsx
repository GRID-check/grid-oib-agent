import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { NetworkDriveCard } from './network-drive-card'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const credential = {
  id: 'cred_1',
  label: 'My MacBook',
  username: 'grid-drive-abc',
  createdAt: '2026-07-01T00:00:00.000Z',
  expiresAt: '2027-07-01T00:00:00.000Z',
  lastUsedAt: null,
}

const created = {
  id: 'cred_2',
  username: 'grid-drive-xyz',
  secret: 'super-secret-password-shown-once',
  expiresAt: '2027-07-14T00:00:00.000Z',
  webdavUrl: 'https://drive.grid.example/dav',
}

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('NetworkDriveCard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('renders the list of active credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { credentials: [credential] })))

    render(<NetworkDriveCard />)

    expect(await screen.findByText('My MacBook')).toBeDefined()
    // lastUsedAt is null → "Never"
    expect(screen.getByText('Never')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Revoke My MacBook' })).toBeDefined()
  })

  test('shows the empty state when there are no credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { credentials: [] })))

    render(<NetworkDriveCard />)

    expect(await screen.findByText('No devices connected yet.')).toBeDefined()
  })

  test('create flow shows the one-time secret and connection instructions', async () => {
    const fetchSpy = vi
      .fn()
      // initial list
      .mockResolvedValueOnce(jsonResponse(200, { credentials: [] }))
      // POST create
      .mockResolvedValueOnce(jsonResponse(201, created))
      // reload after create
      .mockResolvedValueOnce(jsonResponse(200, { credentials: [credential] }))
    vi.stubGlobal('fetch', fetchSpy)

    render(<NetworkDriveCard />)

    await userEvent.click(await screen.findByRole('button', { name: 'Connect a device' }))

    await userEvent.type(screen.getByLabelText('Device name'), 'My PC')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    // The one-time secret is shown as selectable text.
    expect(await screen.findByText('super-secret-password-shown-once')).toBeDefined()
    expect(screen.getByText('grid-drive-xyz')).toBeDefined()
    expect(screen.getByText('https://drive.grid.example/dav')).toBeDefined()
    // The "shown once" warning and per-OS instructions are present.
    expect(screen.getByText(/shown only once/i)).toBeDefined()
    expect(screen.getByText('macOS')).toBeDefined()
    expect(screen.getByText('Windows')).toBeDefined()

    // The POST carried the trimmed label.
    const postCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe('/api/drive/credentials')
    expect(JSON.parse(postCall?.[1].body as string)).toEqual({ label: 'My PC' })
  })

  test('revoke confirms, calls DELETE, and reloads', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { credentials: [credential] }))
      .mockResolvedValueOnce(jsonResponse(204, null))
      .mockResolvedValueOnce(jsonResponse(200, { credentials: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('confirm', vi.fn(() => true))

    render(<NetworkDriveCard />)

    const item = (await screen.findByText('My MacBook')).closest('li') as HTMLElement
    await userEvent.click(within(item).getByRole('button', { name: 'Revoke My MacBook' }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/drive/credentials/cred_1', { method: 'DELETE' }),
    )
    expect(await screen.findByText('No devices connected yet.')).toBeDefined()
  })

  test('does not call DELETE when the revoke confirm is dismissed', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { credentials: [credential] }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('confirm', vi.fn(() => false))

    render(<NetworkDriveCard />)

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke My MacBook' }))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('shows an error state when the list fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})))

    render(<NetworkDriveCard />)

    expect(
      await screen.findByText(/Could not load your network-drive devices/i),
    ).toBeDefined()
  })
})
