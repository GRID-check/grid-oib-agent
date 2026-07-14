/**
 * FB-13 end-of-wizard conflict check. These specs land the wizard directly on
 * the Review step (via a seeded sessionStorage draft) and exercise the Save
 * path: flag off is unchanged, deterministic findings appear instantly, the
 * LLM call is skipped when there is no free text, override saves, revise
 * navigates, and a check failure still saves.
 */
import { render, screen, waitFor } from '@/test-utils'
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
    expect(await screen.findByText(/at most 3 above-ground floors/i)).toBeInTheDocument()
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
    await screen.findByText(/at most 3 above-ground floors/i)

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
    await screen.findByText(/at most 3 above-ground floors/i)

    await user.click(screen.getByRole('button', { name: /revise/i }))

    // Building class lives in the Classification stage (step 3 of 6). The findings
    // clear once the review step finishes animating out.
    expect(await screen.findByText(/step 3 of 6/i)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(/at most 3 above-ground floors/i)).not.toBeInTheDocument(),
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
        { kind: 'ai', fields: ['Tell Grid more'], severity: 'inconsistency', message: 'The note contradicts the plan.' },
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
      freeText: [{ field: 'Tell Grid more', value: 'Confirm the fire-compartment strategy for the submission.' }],
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
