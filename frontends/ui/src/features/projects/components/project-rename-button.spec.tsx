import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { ProjectRenameButton } from './project-rename-button'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

const mockFetch = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

describe('ProjectRenameButton', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('renames via PATCH and refreshes on success', async () => {
    const fetchSpy = mockFetch(200, { id: 'proj-1', name: 'Renamed' })
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<ProjectRenameButton projectId="proj-1" projectName="Old name" />)
    await user.click(screen.getByRole('button', { name: /Rename project/i }))

    const input = await screen.findByLabelText(/Project name/i)
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed' })
    expect(toast.success).toHaveBeenCalled()
    expect(refresh).toHaveBeenCalled()
  })

  test('surfaces a permission error on 403 without refreshing', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden' }))
    const user = userEvent.setup()

    render(<ProjectRenameButton projectId="proj-1" projectName="Old name" />)
    await user.click(screen.getByRole('button', { name: /Rename project/i }))
    const input = await screen.findByLabelText(/Project name/i)
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/permission/i))
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  test('disables save until the name actually changes', async () => {
    vi.stubGlobal('fetch', mockFetch(200))
    const user = userEvent.setup()

    render(<ProjectRenameButton projectId="proj-1" projectName="Old name" />)
    await user.click(screen.getByRole('button', { name: /Rename project/i }))

    expect(await screen.findByRole('button', { name: /^Save$/i })).toBeDisabled()
  })
})
