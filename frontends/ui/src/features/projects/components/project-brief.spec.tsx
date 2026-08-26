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

// Controllable UI locale: keep the real translator (so on-screen text stays
// English, as the other tests assert) but drive `useLocale().locale` per test
// to exercise the stale-language regeneration. Defaults to 'en'.
const localeRef = vi.hoisted(() => ({ current: 'en' }))
vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return {
    ...actual,
    useLocale: () => ({ locale: localeRef.current, setLocale: vi.fn(), localeNames: {} }),
  }
})

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

/**
 * No facts (so summary generation never auto-starts and can't interfere with
 * the fetch mock below) but one pending assumption to confirm/dismiss.
 */
const profileWithAssumption: ProjectProfile = {
  facts: {},
  goals: {},
  unknowns: [],
  assumptions: {
    hauptnutzung: {
      value: 'wohnen',
      status: 'unconfirmed',
      reason: 'Inferred from the uploaded plans.',
      source: 'agent_suggested',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
}

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
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: '', error: 'llm_not_configured' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: 'A crisp brief.' }),
      })
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

    render(
      <ProjectBrief projectId="proj-1" profile={profile} summary="Existing prose." briefStarted />
    )

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
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/no language model/i))
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  test('handles a 403 gracefully', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden' }))
    const user = userEvent.setup()

    render(<ProjectBrief projectId="proj-1" profile={emptyProfile} summary="" briefStarted />)
    await user.click(screen.getByRole('button', { name: /Generate summary/i }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/permission/i))
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  test('offers a subtle Regenerate control when prose is already present', () => {
    render(
      <ProjectBrief projectId="proj-1" profile={profile} summary="Existing prose." briefStarted />
    )
    expect(screen.getByText('Existing prose.')).toBeDefined()
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeDefined()
  })
})

describe('ProjectBrief stale-language summary regeneration (locale switch)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    // Reset the driven locale between tests (other suites rely on the 'en' default).
    localeRef.current = 'en'
  })

  test('regenerates exactly once when the stored summary locale differs from the UI locale', async () => {
    // Summary was written in English; the UI is now German — the classic bug.
    localeRef.current = 'de'
    const fetchSpy = mockFetch(200, { summary: 'Eine deutsche Zusammenfassung.' })
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <ProjectBrief
        projectId="proj-1"
        profile={profile}
        summary="An English summary."
        summaryLocale="en"
        briefStarted
      />
    )

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/generate-summary')
    // Regenerated in the now-active UI locale, not the stale one.
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'de' })
    // Silent repair: the refreshed prose is the feedback, no success toast.
    expect(toast.success).not.toHaveBeenCalled()
  })

  test('does NOT regenerate when the stored summary locale matches the UI locale', () => {
    localeRef.current = 'de'
    const fetchSpy = mockFetch(200, { summary: '' })
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <ProjectBrief
        projectId="proj-1"
        profile={profile}
        summary="Eine deutsche Zusammenfassung."
        summaryLocale="de"
        briefStarted
      />
    )

    expect(screen.getByText('Eine deutsche Zusammenfassung.')).toBeDefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('does NOT regenerate a legacy summary that has no stored locale (fail open)', () => {
    // Legacy row written before summaryLocale existed: unknown is treated as a
    // match, so a locale switch must not trigger a regeneration storm.
    localeRef.current = 'de'
    const fetchSpy = mockFetch(200, { summary: '' })
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <ProjectBrief projectId="proj-1" profile={profile} summary="A legacy summary." briefStarted />
    )

    expect(screen.getByText('A legacy summary.')).toBeDefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('regenerates at most once even if the mismatch persists (no loop on failure)', async () => {
    // Generation fails server-side (empty summary), so the stored locale never
    // updates; a rerender with the still-mismatched props must not re-fire.
    localeRef.current = 'de'
    const fetchSpy = mockFetch(200, { summary: '', error: 'llm_not_configured' })
    vi.stubGlobal('fetch', fetchSpy)

    const { rerender } = render(
      <ProjectBrief
        projectId="proj-1"
        profile={profile}
        summary="An English summary."
        summaryLocale="en"
        briefStarted
      />
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

    rerender(
      <ProjectBrief
        projectId="proj-1"
        profile={profile}
        summary="An English summary."
        summaryLocale="en"
        briefStarted
      />
    )

    // Still exactly one — the attempted-ref guard stops the loop.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
  })
})

describe('ProjectBrief assumption confirm/dismiss error surfacing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('a 403 shows a distinct forbidden message', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'Forbidden', code: 'FORBIDDEN' }))
    const user = userEvent.setup()

    render(
      <ProjectBrief projectId="proj-1" profile={profileWithAssumption} summary="" briefStarted />
    )
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/don.t have permission to update the brief/i)).toBeDefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  test('a 409 shows a distinct conflict message', async () => {
    vi.stubGlobal('fetch', mockFetch(409, { error: 'Conflict', code: 'CONFLICT' }))
    const user = userEvent.setup()

    render(
      <ProjectBrief projectId="proj-1" profile={profileWithAssumption} summary="" briefStarted />
    )
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/changed elsewhere/i)).toBeDefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  test('the 403 and 409 messages are distinct from each other and from the generic failure', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(
      <ProjectBrief projectId="proj-1" profile={profileWithAssumption} summary="" briefStarted />
    )
    await user.click(screen.getByRole('button', { name: /dismiss/i }))

    const generic = await screen.findByText(/could not update the brief/i)
    expect(generic).toBeDefined()
    expect(screen.queryByText(/don.t have permission/i)).toBeNull()
    expect(screen.queryByText(/changed elsewhere/i)).toBeNull()
  })

  test('confirming successfully clears any prior error and refreshes', async () => {
    vi.stubGlobal('fetch', mockFetch(200, {}))
    const user = userEvent.setup()

    render(
      <ProjectBrief projectId="proj-1" profile={profileWithAssumption} summary="" briefStarted />
    )
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(screen.queryByText(/could not update the brief/i)).toBeNull()
  })
})
