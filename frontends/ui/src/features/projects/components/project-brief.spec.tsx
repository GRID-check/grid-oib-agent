import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { ProjectBrief } from './project-brief'
import type { ProjectProfile } from '@/lib/project-profile/types'

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

/** A brief WITH captured facts — summary generation auto-starts for this one. */
const profile: ProjectProfile = {
  facts: {
    hauptnutzung: {
      value: 'wohnen',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

/** A started-but-empty brief — nothing to summarise, so no auto-start. */
const emptyProfile: ProjectProfile = { facts: {}, goals: {}, unknowns: [], assumptions: {} }

describe('ProjectBrief summary auto-generation (post-wizard-save)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('auto-starts generation when facts exist but prose does not, then refreshes silently', async () => {
    const fetchSpy = mockFetch(200, { summary: 'A crisp brief.' })
    vi.stubGlobal('fetch', fetchSpy)

    render(<ProjectBrief projectId="proj-1" profile={profile} summary="" briefStarted />)

    // A visible "writing…" state, not an inviting duplicate-generate button.
    expect(screen.getByText(/writing the project summary/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Generate summary/i })).toBeNull()

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/generate-summary')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'en' })
    // Silent: the prose appearing IS the feedback; no toast on the auto path.
    expect(toast.success).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('an auto-run failure surfaces a calm inline notice plus the manual retry button (no toast)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { summary: '', error: 'llm_not_configured' }))

    render(<ProjectBrief projectId="proj-1" profile={profile} summary="" briefStarted />)

    // The failure is visible on the card, not swallowed — with the retry button.
    expect(await screen.findByText(/summary is currently unavailable/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /Generate summary/i })).toBeDefined()
    // Calm inline state, never an error toast on the auto path.
    expect(toast.error).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  test('an auto-run failure with llm_not_configured shows the specific cause hint', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { summary: '', error: 'llm_not_configured' }))

    render(<ProjectBrief projectId="proj-1" profile={profile} summary="" briefStarted />)

    expect(await screen.findByText(/no AI service is configured/i)).toBeDefined()
  })

  test('a generic auto-run failure shows the notice WITHOUT the no-LLM hint', async () => {
    // Transport failure (non-200) → generic, not the llm_not_configured branch.
    vi.stubGlobal('fetch', mockFetch(500, {}))

    render(<ProjectBrief projectId="proj-1" profile={profile} summary="" briefStarted />)

    expect(await screen.findByText(/summary is currently unavailable/i)).toBeDefined()
    expect(screen.queryByText(/no AI service is configured/i)).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  test('retrying from the inline failure state re-requests generation', async () => {
    // First (auto) call fails; the manual retry then succeeds and refreshes.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: '', error: 'llm_not_configured' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: 'A crisp brief.' }) })
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<ProjectBrief projectId="proj-1" profile={profile} summary="" briefStarted />)

    const retry = await screen.findByRole('button', { name: /Generate summary/i })
    await user.click(retry)

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('does NOT auto-start when the brief has no facts to summarise', () => {
    const fetchSpy = mockFetch(200, { summary: '' })
    vi.stubGlobal('fetch', fetchSpy)

    render(<ProjectBrief projectId="proj-1" profile={emptyProfile} summary="" briefStarted />)

    expect(screen.getByRole('button', { name: /Generate summary/i })).toBeDefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('does NOT auto-start when prose already exists', () => {
    const fetchSpy = mockFetch(200, { summary: '' })
    vi.stubGlobal('fetch', fetchSpy)

    render(<ProjectBrief projectId="proj-1" profile={profile} summary="Existing prose." briefStarted />)

    expect(screen.getByText('Existing prose.')).toBeDefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('ProjectBrief manual summary control', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('generates on click and refreshes with a success toast', async () => {
    const fetchSpy = mockFetch(200, { summary: 'A crisp brief.' })
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    // Empty profile → no auto-start; the click is the only trigger.
    render(<ProjectBrief projectId="proj-1" profile={emptyProfile} summary="" briefStarted />)
    await user.click(screen.getByRole('button', { name: /Generate summary/i }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/generate-summary')
    expect(init.method).toBe('POST')
    expect(toast.success).toHaveBeenCalled()
    expect(refresh).toHaveBeenCalled()
  })

  test('surfaces the no-LLM-configured case with a specific message', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { summary: '', error: 'llm_not_configured' }))
    const user = userEvent.setup()

    render(<ProjectBrief projectId="proj-1" profile={emptyProfile} summary="" briefStarted />)
    await user.click(screen.getByRole('button', { name: /Generate summary/i }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/no language model/i)),
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  test('handles a 403 gracefully', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden' }))
    const user = userEvent.setup()

    render(<ProjectBrief projectId="proj-1" profile={emptyProfile} summary="" briefStarted />)
    await user.click(screen.getByRole('button', { name: /Generate summary/i }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/permission/i)),
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  test('offers a subtle Regenerate control when prose is already present', () => {
    render(
      <ProjectBrief projectId="proj-1" profile={profile} summary="Existing prose." briefStarted />,
    )
    expect(screen.getByText('Existing prose.')).toBeDefined()
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeDefined()
  })
})
