import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { RecentlyDeleted } from './recently-deleted'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const entry = {
  id: 'del_1',
  entityType: 'project',
  entityId: 'proj_1',
  displayName: 'Neubau Wohnbau',
  purgeAfter: '2026-08-01T00:00:00.000Z',
  status: 'pending' as const,
  lastError: null,
}

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

describe('RecentlyDeleted', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders nothing and never fetches without the compliance capability', () => {
    const fetchSpy = mockFetch(200, [entry])
    vi.stubGlobal('fetch', fetchSpy)

    const { container } = render(<RecentlyDeleted canManageCompliance={false} />)

    expect(container).toBeEmptyDOMElement()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('renders nothing on a 403 (no panel for the viewer)', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden' }))

    const { container } = render(<RecentlyDeleted canManageCompliance />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(screen.queryByText(/Recently deleted/i)).toBeNull()
  })

  test('lists pending deletions for a compliance admin', async () => {
    vi.stubGlobal('fetch', mockFetch(200, [entry]))

    render(<RecentlyDeleted canManageCompliance />)

    expect(await screen.findByText('Neubau Wohnbau')).toBeDefined()
    expect(screen.getByRole('button', { name: /Restore/i })).toBeDefined()
  })

  test('shows a retryable error state on a real failure, and retry re-fetches', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [entry] })
    vi.stubGlobal('fetch', fetchSpy)

    render(<RecentlyDeleted canManageCompliance />)

    expect(await screen.findByText(/Could not load recently deleted projects/i)).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /Retry/i }))

    expect(await screen.findByText('Neubau Wohnbau')).toBeDefined()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
