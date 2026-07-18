/**
 * FB-13 end-of-wizard conflict check. These specs land the wizard directly on
 * the Review step (via a seeded sessionStorage draft) and exercise the Save
 * path: flag off is unchanged, deterministic findings appear instantly, the
 * LLM call is skipped when there is no free text, override saves, revise
 * navigates, and a check failure still saves.
 */
import { fireEvent, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectIntakeWizard } from './project-intake-wizard'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'

const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))

const PROJECT_ID = 'p1'

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

/** Route fetch by URL + method; record every call for assertions. */
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
    // /profile (PUT) and /generate-summary (POST)
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetch)
  const stub: FetchStub = { fetch, calls, consistencyResponse: state }
  return stub
}

/** Seed a draft so the wizard restores these answers and opens on the Review step. */
function seedReviewDraft(answers: Record<string, ProjectPrimitiveValue>): void {
  const reviewStep = projectIntakeDefinitionV1.stages.length
  sessionStorage.setItem(`intake-draft-${PROJECT_ID}`, JSON.stringify({ answers, currentStep: reviewStep }))
}

function renderWizard(conflictCheckEnabled: boolean) {
  return render(
    <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" conflictCheckEnabled={conflictCheckEnabled} />,
  )
}

const consistencyCalls = (stub: FetchStub) => stub.calls.filter((c) => c.url.endsWith('/consistency-check'))
const putProfileCalls = (stub: FetchStub) =>
  stub.calls.filter((c) => c.url.endsWith(`/projects/${PROJECT_ID}/profile`) && c.method === 'PUT')

describe('ProjectIntakeWizard — FB-13 conflict check', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => {
    sessionStorage.clear()
  })

  it('flag OFF: Save persists immediately with no consistency check', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Answers that WOULD be flagged if the check were on.
    seedReviewDraft({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: 8 })
    renderWizard(false)

    const saveButton = await screen.findByRole('button', { name: /save/i })
    await user.click(saveButton)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(consistencyCalls(stub)).toHaveLength(0)
    expect(putProfileCalls(stub)).toHaveLength(1)
  })

  it('flag ON: a deterministic conflict appears instantly and holds the save', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: 8 })
    renderWizard(true)

    const saveButton = await screen.findByRole('button', { name: /save & see/i })
    await user.click(saveButton)

    // The deterministic finding renders...
    expect(await screen.findByText(/no more than 4 above-ground storeys/i)).toBeInTheDocument()
    // ...the save is held (no PUT)...
    expect(putProfileCalls(stub)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
    // ...and with no free text present, the LLM was never called.
    expect(consistencyCalls(stub)).toHaveLength(0)
  })

  it('flag ON: "Save anyway" overrides the findings and persists', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: 8 })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))
    await screen.findByText(/no more than 4 above-ground storeys/i)

    await user.click(screen.getByRole('button', { name: /save anyway/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(putProfileCalls(stub)).toHaveLength(1)
  })

  it('flag ON: "Revise" navigates to the offending stage and clears findings', async () => {
    const user = userEvent.setup()
    stubFetch()
    seedReviewDraft({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: 8 })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))
    await screen.findByText(/no more than 4 above-ground storeys/i)

    await user.click(screen.getByRole('button', { name: /revise/i }))

    // Building class lives in the Classification stage (step 3 of 6). The findings
    // clear once the review step finishes animating out.
    expect(await screen.findByText(/step 3 of 6/i)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(/no more than 4 above-ground storeys/i)).not.toBeInTheDocument(),
    )
  })

  it('flag ON: no substantive free text → the LLM is never called', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Consistent structured answers, and a too-short "other" note (< 10 chars).
    seedReviewDraft({
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 10,
      focus_areas: ['sonstiges'],
      goal_details: 'ok',
    })
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
        { kind: 'ai', fields: ['Tell Piloti more'], severity: 'inconsistency', message: 'The note contradicts the plan.' },
      ],
    }
    seedReviewDraft({
      focus_areas: ['sonstiges'],
      goal_details: 'Confirm the fire-compartment strategy for the submission.',
    })
    renderWizard(true)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    expect(await screen.findByText(/the note contradicts the plan/i)).toBeInTheDocument()
    const call = consistencyCalls(stub)[0]
    expect(call).toBeDefined()
    expect(call.body).toMatchObject({
      freeText: [{ field: 'Tell Piloti more', value: 'Confirm the fire-compartment strategy for the submission.' }],
    })
  })

  it('flag ON: a failed check still lets the save proceed (fail-open)', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    stub.consistencyResponse.status = 500
    stub.consistencyResponse.json = {}
    seedReviewDraft({
      focus_areas: ['sonstiges'],
      goal_details: 'A substantive free-text note to force the network call.',
    })
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
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  it('saves and navigates without ever calling generate-summary (the Overview brief owns it)', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()

    seedReviewDraft({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: 8 })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(refreshMock).toHaveBeenCalled()
    expect(putProfileCalls(stub)).toHaveLength(1)
    // The wizard's old fire-and-forget always lost the race against the redirect
    // (the summary landed after the Overview rendered) — generation now lives in
    // the Overview's brief panel, where the result is actually displayed.
    expect(stub.calls.some((c) => c.url.endsWith('/generate-summary'))).toBe(false)
  })
})

describe('ProjectIntakeWizard — optimistic concurrency (If-Match)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  const recordHeaders = () => {
    const headers: Array<Record<string, string> | undefined> = []
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/intake-definition')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => projectIntakeDefinitionV1 })
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
    seedReviewDraft({ hauptnutzung: 'wohnen', anzahl_einheiten: 3 })
    render(
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" initialProfileVersion={7} />,
    )

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalled())
    expect(headers[0]?.['If-Match']).toBe('7')
  })

  it('omits If-Match when no version was provided (legacy behavior)', async () => {
    const user = userEvent.setup()
    const headers = recordHeaders()
    seedReviewDraft({ hauptnutzung: 'wohnen', anzahl_einheiten: 3 })
    renderWizard(false)

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalled())
    expect(headers[0]?.['If-Match']).toBeUndefined()
  })

  it('a 409 surfaces the conflict message and does not navigate', async () => {
    const user = userEvent.setup()
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/intake-definition')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => projectIntakeDefinitionV1 })
      }
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetch)
    seedReviewDraft({ hauptnutzung: 'wohnen', anzahl_einheiten: 3 })
    render(
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" initialProfileVersion={7} />,
    )

    await user.click(await screen.findByRole('button', { name: /save/i }))

    expect(await screen.findByText(/changed elsewhere/i)).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('ProjectIntakeWizard — edit-mode save preserves agent-recorded knowledge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  it('carries novel facts/goals/unknowns through the whole-profile PUT', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    seedReviewDraft({ hauptnutzung: 'wohnen', anzahl_einheiten: 3 })
    const initialProfile = {
      facts: {
        // Novel key the agent recorded via the patch flow — no intake question owns it.
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
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" mode="edit" initialProfile={initialProfile} />,
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
    // The wizard's own answers still land as usual.
    expect(body.facts.hauptnutzung?.value).toBe('wohnen')
  })
})

describe('ProjectIntakeWizard — Fix 1 salvage banner', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  it('shows the partial-replacement banner when some parts were dropped', async () => {
    stubFetch()
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" salvageNotice="partial" />)
    expect(
      await screen.findByText(/parts of the existing project brief could not be loaded and will be replaced/i),
    ).toBeInTheDocument()
  })

  it('shows the full-failure banner when nothing was salvageable', async () => {
    stubFetch()
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" salvageNotice="full" />)
    expect(await screen.findByText(/the existing project brief could not be loaded\. anything you enter/i)).toBeInTheDocument()
  })

  it('shows no banner when the stored brief loaded cleanly', async () => {
    stubFetch()
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" />)
    // Wait for the definition to load (step counter appears), then assert no banner.
    await screen.findByText(/step 1 of 6/i)
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument()
  })
})

describe('ProjectIntakeWizard — assumptions-only edit preserves assumptions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  it('carries loaded assumptions into the PUT payload on an edit-mode save', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Land on Review via a seeded draft; the assumption comes from the loaded
    // profile (the wizard's questions never round-trip assumptions).
    seedReviewDraft({ hauptnutzung: 'wohnen' })
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
      <ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" mode="edit" initialProfile={initialProfile} />,
    )

    await user.click(await screen.findByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    const put = putProfileCalls(stub)[0]
    expect(put).toBeDefined()
    const body = put.body as { assumptions?: Record<string, { value?: unknown }> }
    expect(body.assumptions?.widmung?.value).toBe('wohnen')
  })
})

describe('ProjectIntakeWizard — Fix 6 stale conditional answers pruned on load', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  it('prunes an orphaned conditional answer from a restored draft so save is clean', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Bed count is only valid when the use is Hospitality. A restored draft with
    // Office + a stale bed count would trip the orphanedAnswer rule and HOLD the
    // save — unless the load path prunes it like an interactive edit would.
    seedReviewDraft({ hauptnutzung: 'buero', anzahl_betten: 40 })
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" conflictCheckEnabled />)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    // Pruned on load → no orphan finding → the save proceeds straight through.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    expect(putProfileCalls(stub)).toHaveLength(1)
    expect(screen.queryByText(/no longer applies/i)).not.toBeInTheDocument()
  })
})

describe('ProjectIntakeWizard — Fix 5 non-finite number rejected', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  afterEach(() => sessionStorage.clear())

  it('rejects "1e999" (Infinity) with a validation error and neither advances nor saves', async () => {
    const user = userEvent.setup()
    const stub = stubFetch()
    // Land on the Building details stage (index 3) with the other two fields valid.
    const buildingStep = 3
    sessionStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({ answers: { geschosse_unterirdisch: 1, fluchtniveau: '<=7m' }, currentStep: buildingStep }),
    )
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" />)

    const floors = await screen.findByLabelText('Above-ground floors')
    // "1e999" is a valid numeric literal but Number("1e999") === Infinity.
    fireEvent.change(floors, { target: { value: '1e999' } })

    await user.click(screen.getByRole('button', { name: /next/i }))

    // The field shows the normal invalid-input state and the step does not advance.
    expect(await screen.findByText(/enter a number/i)).toBeInTheDocument()
    expect(screen.getByText(/step 4 of 6/i)).toBeInTheDocument()
    // Nothing was persisted.
    expect(putProfileCalls(stub)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
  })
})
