/**
 * Wizard behaviour specs, updated for the modules-A–H intake. These land the
 * wizard on a specific module (via a seeded localStorage draft) and exercise
 * the Save path, the FB-13 conflict check, optimistic concurrency, draft
 * freshness, and numeric validation. The deterministic rule under test is the
 * fossil-fuel-on-a-new-build conflict (E1=gas + A5 includes Neubau).
 */
import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ProjectIntakeWizard } from './project-intake-wizard'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))

const PROJECT_ID = 'p1'
const REVIEW_STEP = projectIntakeDefinitionV1.stages.length - 1 // module H
const TOTAL = projectIntakeDefinitionV1.stages.length // 8

interface Recorded {
  url: string
  method: string
  body: unknown
}

interface FetchStub {
  fetch: ReturnType<typeof vi.fn>
  calls: Recorded[]
  consistencyResponse: { status: number; json: unknown }
}

function stubFetch(): FetchStub {
  const calls: Recorded[] = []
  const state: FetchStub['consistencyResponse'] = { status: 200, json: { findings: [] } }
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })

    if (url.endsWith('/intake-definition')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => projectIntakeDefinitionV1 })
    }
    if (url.endsWith('/consistency-check')) {
      return Promise.resolve({
        ok: state.status >= 200 && state.status < 300,
        status: state.status,
        json: async () => state.json,
        text: async () => '',
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, calls, consistencyResponse: state }
}

/**
 * The answers the wizard hard-requires (A1 / A2_adr / A2_country / A2_land / A5).
 *
 * `A2_adr` is deliberately under the free-text threshold (10 chars): it is a
 * `text` question, so a realistic street address would enrol every fixture in
 * the LLM consistency check and change what the flag-OFF cases are testing.
 *
 * Every review-step fixture carries them because a real user cannot reach a
 * successful save without them: `handleSave` refuses and jumps to the first one
 * missing. A fixture without them models a user who cannot exist — and used to
 * pass only because that gate did not exist.
 */
const REQUIRED_ANSWERS: Record<string, ProjectPrimitiveValue> = {
  A1: 'Test',
  A2_adr: 'Wien 1',
  A2_country: 'at',
  A2_land: 'tirol',
  A5: ['neubau'],
}

/** Seed a draft so the wizard restores these answers and opens on the Review step (module H). */
function seedReviewDraft(answers: Record<string, ProjectPrimitiveValue>, savedAt?: number): void {
  localStorage.setItem(
    `intake-draft-${PROJECT_ID}`,
    JSON.stringify({
      answers: { ...REQUIRED_ANSWERS, ...answers },
      currentStep: REVIEW_STEP,
      ...(savedAt !== undefined ? { savedAt } : {}),
    })
  )
}

function renderWizard(conflictCheckEnabled: boolean) {
  return render(
    <ProjectIntakeWizard
      projectId={PROJECT_ID}
      projectName="Test"
      conflictCheckEnabled={conflictCheckEnabled}
    />
  )
}

const consistencyCalls = (stub: FetchStub) =>
  stub.calls.filter((c) => c.url.endsWith('/consistency-check'))
const putProfileCalls = (stub: FetchStub) =>
  stub.calls.filter((c) => c.url.endsWith(`/projects/${PROJECT_ID}/profile`) && c.method === 'PUT')

// Answers that trigger the fossil-fuel-on-a-new-build conflict.
const FOSSIL_CONFLICT: Record<string, ProjectPrimitiveValue> = { A5: ['neubau'], 'E1@bw1': 'gas' }

describe('ProjectIntakeWizard — FB-13 conflict check', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('flag OFF: Save persists immediately with no consistency check', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft(FOSSIL_CONFLICT)
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(consistencyCalls(stub)).toHaveLength(0)
    expect(putProfileCalls(stub)).toHaveLength(1)
  })

  it('flag ON: a deterministic conflict appears instantly and holds the save', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft(FOSSIL_CONFLICT)
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    expect(await screen.findByText(/Erneuerbare-Wärme-Gesetz/i)).toBeInTheDocument()
    expect(putProfileCalls(stub)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
    // No free text present → the LLM was never called.
    expect(consistencyCalls(stub)).toHaveLength(0)
  })

  it('flag ON: "Save anyway" overrides the findings and persists', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft(FOSSIL_CONFLICT)
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))
    await screen.findByText(/Erneuerbare-Wärme-Gesetz/i)

    await user.click(screen.getByRole('button', { name: /save anyway/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(putProfileCalls(stub)).toHaveLength(1)
  })

  it('flag ON: "Revise" navigates to the offending stage and clears findings', async () => {
    const user = userEvent.setup()
    stubFetch()
    seedReviewDraft(FOSSIL_CONFLICT)
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))
    await screen.findByText(/Erneuerbare-Wärme-Gesetz/i)

    await user.click(screen.getByRole('button', { name: /revise/i }))

    // "Art des Vorhabens" (A5) lives in module A → step 1 of 8. Findings clear.
    expect(await screen.findByText(new RegExp(`step 1 of ${TOTAL}`, 'i'))).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(/Erneuerbare-Wärme-Gesetz/i)).not.toBeInTheDocument()
    )
  })

  it('flag ON: no substantive free text → the LLM is never called', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Consistent structured answers, and a too-short context note (< 10 chars).
    seedReviewDraft({ A2_land: 'wien', A5: ['umbau'], G1: 'ok' })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(consistencyCalls(stub)).toHaveLength(0)
    expect(putProfileCalls(stub)).toHaveLength(1)
  })

  it('flag ON: substantive free text triggers the LLM call with the free-text payload', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    stub.consistencyResponse.json = {
      findings: [
        {
          kind: 'ai',
          fields: ['Projektbeschreibung, Entwurfsidee & Umfeld'],
          severity: 'inconsistency',
          message: 'The note contradicts the plan.',
        },
      ],
    }
    seedReviewDraft({ G1: 'Ein ausführlicher Freitext über das Brandschutzkonzept.' })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    expect(await screen.findByText(/the note contradicts the plan/i)).toBeInTheDocument()
    const call = consistencyCalls(stub)[0]
    expect(call).toBeDefined()
    expect(call.body).toMatchObject({
      freeText: [
        {
          field: 'Projektbeschreibung, Entwurfsidee & Umfeld',
          value: 'Ein ausführlicher Freitext über das Brandschutzkonzept.',
        },
      ],
    })
  })

  it('flag ON: a failed check still lets the save proceed (fail-open)', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    stub.consistencyResponse.status = 500
    stub.consistencyResponse.json = {}
    seedReviewDraft({ G1: 'Ein ausführlicher Freitext, der den Netzwerkaufruf erzwingt.' })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(consistencyCalls(stub)).toHaveLength(1)
    expect(putProfileCalls(stub)).toHaveLength(1)
  })
})

describe('ProjectIntakeWizard — summary generation is fully off the save path', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('saves and navigates without ever calling generate-summary (the Overview brief owns it)', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()

    seedReviewDraft({ A2_land: 'wien', A5: ['neubau'] })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(refreshMock).toHaveBeenCalled()
    expect(putProfileCalls(stub)).toHaveLength(1)
    expect(stub.calls.some((c) => c.url.endsWith('/generate-summary'))).toBe(false)
  })
})

describe('ProjectIntakeWizard — Fix 3 save-success feedback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('toasts a save confirmation with the captured-fact count after a successful save', async () => {
    const user = userEvent.setup()
    stubFetch()
    // project_name + standort_adresse + country + bundesland + vorhabensart:
    // the five facts the required-answer set produces.
    seedReviewDraft({ A2_land: 'wien' })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/5 details captured/i))
  })

  it('does NOT toast a success when the save fails', async () => {
    const user = userEvent.setup()
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/intake-definition')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectIntakeDefinitionV1,
        })
      }
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetch)
    seedReviewDraft({ A2_land: 'wien', A5: ['neubau'] })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(screen.getByText(/could not save/i)).toBeInTheDocument())
    expect(toast.success).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('ProjectIntakeWizard — optimistic concurrency (If-Match)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  const recordHeaders = () => {
    const headers: Array<Record<string, string> | undefined> = []
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/intake-definition')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectIntakeDefinitionV1,
        })
      }
      if (init?.method === 'PUT') headers.push(init.headers as Record<string, string>)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetch)
    return headers
  }

  it('sends the loaded profileVersion as If-Match so concurrent edits 409', async () => {
    const user = userEvent.setup()
    const headers = recordHeaders()
    seedReviewDraft({ A2_land: 'wien' })
    render(
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" initialProfileVersion={7} />
    )

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalled())
    expect(headers[0]?.['If-Match']).toBe('7')
  })

  it('omits If-Match when no version was provided (legacy behavior)', async () => {
    const user = userEvent.setup()
    const headers = recordHeaders()
    seedReviewDraft({ A2_land: 'wien' })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalled())
    expect(headers[0]?.['If-Match']).toBeUndefined()
  })

  it('a 409 surfaces the conflict message and does not navigate', async () => {
    const user = userEvent.setup()
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/intake-definition')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectIntakeDefinitionV1,
        })
      }
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetch)
    seedReviewDraft({ A2_land: 'wien' })
    render(
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" initialProfileVersion={7} />
    )

    await user.click(await screen.findByRole('button', { name: /save/i }))

    expect(await screen.findByText(/changed elsewhere/i)).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('Fix 3: the 409 alert offers a Refresh action that re-fetches server data', async () => {
    const user = userEvent.setup()
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/intake-definition')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => projectIntakeDefinitionV1,
        })
      }
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetch)
    seedReviewDraft({ A2_land: 'wien' })
    render(
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" initialProfileVersion={7} />
    )

    await user.click(await screen.findByRole('button', { name: /save/i }))
    await screen.findByText(/changed elsewhere/i)

    await user.click(screen.getByRole('button', { name: /refresh/i }))
    expect(refreshMock).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText(/changed elsewhere/i)).not.toBeInTheDocument())
  })
})

describe('ProjectIntakeWizard — edit-mode save preserves agent-recorded knowledge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('carries novel facts/goals/unknowns through the whole-profile PUT', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft({ A2_country: 'at', A2_land: 'wien' }, Date.parse('2026-01-02T00:00:00.000Z'))
    const initialProfile = {
      facts: {
        brandabschnitt_flaeche: {
          value: 1200,
          confidence: 'confirmed' as const,
          source: 'user_confirmed' as const,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      goals: { zieltermin: '2027-03-01' },
      unknowns: ['statik_gutachten'],
      assumptions: {},
    }
    render(
      <ProjectIntakeWizard
        projectId={PROJECT_ID}
        projectName="Test"
        mode="edit"
        initialProfile={initialProfile}
      />
    )

    await user.click(await screen.findByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    const body = putProfileCalls(stub)[0].body as {
      facts: Record<string, { value?: unknown }>
      goals: Record<string, unknown>
      unknowns: string[]
    }
    expect(body.facts.brandabschnitt_flaeche?.value).toBe(1200)
    expect(body.goals.zieltermin).toBe('2027-03-01')
    expect(body.unknowns).toContain('statik_gutachten')
    // The wizard's own answer still lands as usual.
    expect(body.facts.bundesland?.value).toBe('wien')
  })
})

describe('ProjectIntakeWizard — Fix 1 salvage banner', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('shows the partial-replacement banner when some parts were dropped', async () => {
    stubFetch()
    render(
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" salvageNotice="partial" />
    )
    expect(
      await screen.findByText(
        /parts of the existing project brief could not be loaded and will be replaced/i
      )
    ).toBeInTheDocument()
  })

  it('shows the full-failure banner when nothing was salvageable', async () => {
    stubFetch()
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" salvageNotice="full" />)
    expect(
      await screen.findByText(
        /the existing project brief could not be loaded\. anything you enter/i
      )
    ).toBeInTheDocument()
  })

  it('shows no banner when the stored brief loaded cleanly', async () => {
    stubFetch()
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" />)
    await screen.findByText(new RegExp(`step 1 of ${TOTAL}`, 'i'))
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument()
  })
})

describe('ProjectIntakeWizard — assumptions-only edit preserves assumptions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('carries loaded assumptions into the PUT payload on an edit-mode save', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft({ A2_land: 'wien' }, Date.parse('2026-01-02T00:00:00.000Z'))
    const initialProfile = {
      facts: {},
      goals: {},
      unknowns: [],
      assumptions: {
        widmung: {
          value: 'wohnen',
          status: 'unconfirmed' as const,
          reason: 'agent guess',
          source: 'agent_suggested' as const,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    render(
      <ProjectIntakeWizard
        projectId={PROJECT_ID}
        projectName="Test"
        mode="edit"
        initialProfile={initialProfile}
      />
    )

    await user.click(await screen.findByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    const body = putProfileCalls(stub)[0].body as {
      assumptions?: Record<string, { value?: unknown }>
    }
    expect(body.assumptions?.widmung?.value).toBe('wohnen')
  })
})

describe('ProjectIntakeWizard — stale conditional answers pruned on load', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('prunes an orphaned conditional answer from a restored draft before saving', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // A6 (Baujahr) only applies to existing-building work. A restored draft with
    // pure Neubau + a stale Baujahr must be pruned on load like an interactive edit.
    seedReviewDraft({ A5: ['neubau'], A6: 1990, A6__mode: 'wert' })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    const body = putProfileCalls(stub)[0].body as { facts: Record<string, unknown> }
    // The pruned Baujahr never reaches the persisted profile.
    expect(body.facts.baujahr_bestand).toBeUndefined()
  })
})

describe('ProjectIntakeWizard — Fix 1 stale draft does not clobber a newer profile', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  const vorhabenFact = (value: string[], updatedAt: string) => ({
    value,
    confidence: 'confirmed' as const,
    source: 'user_confirmed' as const,
    updatedAt,
  })
  const chip = (name: string) => screen.getByRole('button', { name })

  it('discards a draft older than the persisted profile and prefills from the profile', async () => {
    stubFetch()
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({
        answers: { A5: ['sanierung'] },
        currentStep: 0,
        savedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      })
    )
    const initialProfile = {
      facts: { vorhabensart: vorhabenFact(['neubau'], '2026-07-01T00:00:00.000Z') },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    render(
      <ProjectIntakeWizard
        projectId={PROJECT_ID}
        projectName="Test"
        mode="edit"
        initialProfile={initialProfile}
      />
    )

    await waitFor(() => expect(chip('Neubau')).toHaveAttribute('aria-pressed', 'true'))
    expect(chip('Sanierung')).toHaveAttribute('aria-pressed', 'false')
  })

  it('restores a draft newer than the persisted profile (genuine local edits survive)', async () => {
    stubFetch()
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({
        answers: { A5: ['sanierung'] },
        currentStep: 0,
        savedAt: Date.parse('2026-07-20T00:00:00.000Z'),
      })
    )
    const initialProfile = {
      facts: { vorhabensart: vorhabenFact(['neubau'], '2026-07-01T00:00:00.000Z') },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    render(
      <ProjectIntakeWizard
        projectId={PROJECT_ID}
        projectName="Test"
        mode="edit"
        initialProfile={initialProfile}
      />
    )

    await waitFor(() => expect(chip('Sanierung')).toHaveAttribute('aria-pressed', 'true'))
    expect(chip('Neubau')).toHaveAttribute('aria-pressed', 'false')
  })

  it('discards a draft whose base profileVersion is behind the loaded version', async () => {
    stubFetch()
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({
        answers: { A5: ['sanierung'] },
        currentStep: 0,
        savedAt: Date.now(),
        baseVersion: 3,
      })
    )
    const initialProfile = {
      facts: { vorhabensart: vorhabenFact(['neubau'], '2026-07-01T00:00:00.000Z') },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    render(
      <ProjectIntakeWizard
        projectId={PROJECT_ID}
        projectName="Test"
        mode="edit"
        initialProfile={initialProfile}
        initialProfileVersion={4}
      />
    )

    await waitFor(() => expect(chip('Neubau')).toHaveAttribute('aria-pressed', 'true'))
    expect(chip('Sanierung')).toHaveAttribute('aria-pressed', 'false')
  })

  it('migration window: a legacy draft with neither baseVersion nor savedAt does not win over the profile', async () => {
    stubFetch()
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({ answers: { A5: ['sanierung'] }, currentStep: 0 })
    )
    const initialProfile = {
      facts: { vorhabensart: vorhabenFact(['neubau'], '2026-07-01T00:00:00.000Z') },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    render(
      <ProjectIntakeWizard
        projectId={PROJECT_ID}
        projectName="Test"
        mode="edit"
        initialProfile={initialProfile}
      />
    )

    await waitFor(() => expect(chip('Neubau')).toHaveAttribute('aria-pressed', 'true'))
    expect(chip('Sanierung')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('ProjectIntakeWizard — Fix 2 AI-finding revise link resolves a stage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('renders a working Revise link for an AI finding whose labels match no question', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    stub.consistencyResponse.json = {
      findings: [
        {
          kind: 'ai',
          fields: ['the fire-compartment note'],
          severity: 'inconsistency',
          message: 'The note contradicts the plan.',
        },
      ],
    }
    seedReviewDraft({ G1: 'Bestätige die Brandabschnittsstrategie für die Einreichung.' })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))
    expect(await screen.findByText(/the note contradicts the plan/i)).toBeInTheDocument()

    // The link falls back to the first free-text stage (module A, A1 is text) → step 1.
    await user.click(screen.getByRole('button', { name: /revise/i }))
    expect(await screen.findByText(new RegExp(`step 1 of ${TOTAL}`, 'i'))).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(/the note contradicts the plan/i)).not.toBeInTheDocument()
    )
  })
})

describe('ProjectIntakeWizard — Fix 5 non-finite number rejected', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('rejects "1e999" (Infinity) with a validation error and neither advances nor saves', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Land on module C (index 2) with the building set to a Gebäude so C2 shows.
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({ answers: { 'C1@bw1': 'gebaeude' }, currentStep: 2 })
    )
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" />)

    const floors = await screen.findByLabelText('Anzahl oberirdischer Geschoße (Zielzustand)')
    fireEvent.change(floors, { target: { value: '1e999' } })

    await user.click(screen.getByRole('button', { name: /next/i }))

    expect(await screen.findByText(/enter a number/i)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`step 3 of ${TOTAL}`, 'i'))).toBeInTheDocument()
    expect(putProfileCalls(stub)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('ProjectIntakeWizard — module rail', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('names every module in full rather than truncating it', async () => {
    stubFetch()
    renderWizard(false)
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })

    // The horizontal stepper this replaced cut every label to ~8 characters,
    // which turned three different modules into "Grundstück …" / "Technik &
    // En…" / "Zusammenfa…". Full titles are the rail's whole reason to exist.
    for (const title of [
      'Grundstück & Widmung',
      'Technik & Energie',
      'Verfahren & Sonderrecht',
      'Zusammenfassung',
    ]) {
      expect(within(rail).getByText(title)).toBeInTheDocument()
    }
  })

  it('lets the user jump to a module they have not reached yet', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })

    // Validation is soft everywhere but A1/A2/A5, so a rail that locked
    // unvisited modules would enforce a gate the questionnaire does not have.
    await user.click(within(rail).getByText('Projektkontext'))
    expect(await screen.findByText(/Modul G/)).toBeInTheDocument()
  })

  it('counts answers per module as they are given', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })
    const moduleA = within(rail).getByText('Projektbasis').closest('button')!

    // A1 is seeded from the project name, so module A opens at 1 of 5.
    expect(within(moduleA).getByText('1 of 5')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Adresse \/ Gemeinde/), 'Innrain 1, 6020 Innsbruck')
    await waitFor(() => expect(within(moduleA).getByText('2 of 5')).toBeInTheDocument())
  })
})

describe('ProjectIntakeWizard — Schnellstart', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  /** Module B: B1/B1_text/B2 are core, the risk/noise/erschliessung block is not. */
  async function openModuleB(user: ReturnType<typeof userEvent.setup>) {
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })
    await user.click(within(rail).getByText('Grundstück & Widmung'))
    await screen.findByText(/Modul B/)
  }

  it('narrows the module to its Kernfragen and says what it hid', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    await openModuleB(user)

    expect(screen.getByLabelText(/Lärmsituation am Standort/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /quick start/i }))

    // Core survives, non-core goes, and the count says how much went.
    expect(screen.getByLabelText(/Flächenwidmung \(Kategorie\)/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Lärmsituation am Standort/)).not.toBeInTheDocument()
    expect(screen.getByText(/hidden in quick start/i)).toBeInTheDocument()
  })

  it('brings the hidden questions back for this module on request', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    await openModuleB(user)
    await user.click(screen.getByRole('button', { name: /quick start/i }))

    // A count the user cannot act on would just be a nag.
    await user.click(screen.getByRole('button', { name: /show all here/i }))
    expect(screen.queryByText(/hidden in quick start/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Lärmsituation am Standort/)).toBeInTheDocument()
  })

  it('a module with no non-core questions shows no hidden-count nag', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    await screen.findByText(/Modul A/)

    // Every question v1.2 leaves in module A is core, so Schnellstart has
    // nothing to hide there and must stay silent rather than print "0 more".
    await user.click(screen.getByRole('button', { name: /quick start/i }))
    expect(screen.queryByText(/hidden in quick start/i)).not.toBeInTheDocument()
  })

  it('never hides a required question', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    await screen.findByText(/Modul A/)
    await user.click(screen.getByRole('button', { name: /quick start/i }))

    // Only A1/A2/A5 are hard-required and all are core; this guards the case
    // where a later `required: true` lands on a non-core question.
    for (const label of [/Projektname/, /Adresse \/ Gemeinde/, /^Land/]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
  })
})

describe('ProjectIntakeWizard — Rest überspringen', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it("records the module's unanswered questions as explicitly open", async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })
    await user.click(within(rail).getByText('Projektkontext'))
    await screen.findByText(/Modul G/)
    const moduleG = within(rail).getByText('Projektkontext').closest('button')!

    expect(within(moduleG).getByText('0 of 4')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /skip the rest/i }))

    // Explicitly open counts as answered: both produce an `unknown` in the
    // profile, but only the explicit one is distinguishable from "not reached"
    // in Modul H's completion checklist.
    await waitFor(() => expect(within(moduleG).getByText('complete')).toBeInTheDocument())
  })

  it('leaves the required questions of a module untouched', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })
    const moduleA = within(rail).getByText('Projektbasis').closest('button')!

    // A1 is seeded from the project name; A2_adr/A2_country stay required, so
    // module A can never be skipped to "complete".
    await user.click(screen.getByRole('button', { name: /skip the rest/i }))
    await waitFor(() => expect(within(moduleA).getByText(/of/)).toBeInTheDocument())
    // Never "complete": the required questions are still unanswered.
    expect(within(moduleA).queryByText('complete')).not.toBeInTheDocument()
  })

  it('leaves a required question for the user to answer', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderWizard(false)
    await screen.findByText(/Modul A/)
    await user.click(screen.getByRole('button', { name: /skip the rest/i }))

    // Skipping must not open the one gate the spec keeps closed.
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    expect(await screen.findByText(/Modul A/)).toBeInTheDocument()
  })
})

describe('ProjectIntakeWizard — required answers gate the save', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  /** A draft that lands on Modul H with a required answer missing. */
  function seedIncompleteReviewDraft(omit: string): void {
    const answers: Record<string, ProjectPrimitiveValue> = { ...REQUIRED_ANSWERS }
    delete answers[omit]
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({ answers, currentStep: REVIEW_STEP })
    )
  }

  it('refuses to persist a profile missing a required answer', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedIncompleteReviewDraft('A5')
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    // Modul H declares no required questions of its own, so before this gate
    // ANY route onto it — the module rail, a restored draft, a condition that
    // turned a question visible after it was passed — could save without them.
    await waitFor(() => expect(screen.getByText(/Modul A/)).toBeInTheDocument())
    expect(putProfileCalls(stub)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('lands the user on the unanswered question with its error showing', async () => {
    const user = userEvent.setup()
    stubFetch()
    seedIncompleteReviewDraft('A5')
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    // Refusing from the summary with nothing to act on would be worse than the
    // hole it closes.
    // A5 renders as a chip group, so the label owns no form control to query by
    // — and its title also appears in the rail, hence findAllByText.
    expect((await screen.findAllByText(/Art des Vorhabens/)).length).toBeGreaterThan(0)
    expect(await screen.findByText(/mindestens eine Option|at least one/i)).toBeInTheDocument()
  })

  it('saves once every required answer is present', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft({})
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(putProfileCalls(stub)).toHaveLength(1))
  })

  it('the module rail can reach the summary without opening that hole', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // No draft: a fresh wizard on Modul A, only A1 seeded from the project name.
    renderWizard(false)
    const rail = await screen.findByRole('navigation', { name: /wizard modules/i })

    await user.click(within(rail).getByText('Zusammenfassung'))
    await user.click(await screen.findByRole('button', { name: /save/i }))

    // Free navigation stays — the gate is on the save, not on the rail.
    expect(putProfileCalls(stub)).toHaveLength(0)
  })
})
