/**
 * Fix 2: the deterministic pre-save gate runs before the actual save and used to
 * sit OUTSIDE any try/catch while Save was fired as `void handleSave()` — so any
 * throw there left the Save button silently inert. The gate is now wrapped: on a
 * throw it logs and proceeds straight to the save (fail-open). This spec mocks the
 * checker to throw and asserts the save still completes.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))

// The deterministic gate throws; the free-text collectors are inert.
vi.mock('@/lib/project-profile/intake-consistency', () => ({
  checkIntakeConsistencyFromAnswers: () => {
    throw new Error('boom')
  },
  collectFreeTextFields: () => [],
  collectStructuredContextFields: () => [],
}))

import { ProjectIntakeWizard } from './project-intake-wizard'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'

const PROJECT_ID = 'p1'

interface Recorded {
  url: string
  method: string
}

function stubFetch(): { calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.endsWith('/intake-definition')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => projectIntakeDefinitionV1 })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls }
}

describe('ProjectIntakeWizard — Fix 2 pre-save gate fail-open', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('saves anyway when the deterministic gate throws (flag ON)', async () => {
    const user = userEvent.setup()
    const { calls } = stubFetch()
    const reviewStep = projectIntakeDefinitionV1.stages.length - 1
    localStorage.setItem(
      `intake-draft-${PROJECT_ID}`,
      JSON.stringify({ answers: { A2_land: 'wien' }, currentStep: reviewStep })
    )
    render(<ProjectIntakeWizard projectId={PROJECT_ID} projectName="Test" conflictCheckEnabled />)

    await user.click(await screen.findByRole('button', { name: /save & see/i }))

    // The save completed despite the gate throwing.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/app/projects/${PROJECT_ID}`))
    const putCalls = calls.filter(
      (c) => c.url.endsWith(`/projects/${PROJECT_ID}/profile`) && c.method === 'PUT'
    )
    expect(putCalls).toHaveLength(1)
    // ...and the throw was logged rather than swallowed silently.
    expect(console.error).toHaveBeenCalled()
  })
})
