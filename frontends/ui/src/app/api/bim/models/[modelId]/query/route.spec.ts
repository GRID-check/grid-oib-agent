/**
 * @vitest-environment node
 */
/**
 * The BIM query route's rate-limit posture.
 *
 * Worth its own spec because the bug it pins was invisible from either side
 * alone. This route is a READ that has to travel as POST — its request is a
 * nested filter object — so the factory's default charged it against
 * `api-mutation`, the bucket document UPLOADS spend. Opening a model in the
 * viewer walks every element of the building, and that walk drained the budget
 * the next upload needed: PDFs uploaded fine, IFC uploads came back
 * `{"code":"RATE_LIMITED","policy":"api-mutation"}`, because only IFC has a
 * viewer that pages a whole model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requireAuthorizedSession = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: () => requireAuthorizedSession(),
}))
vi.mock('server-only', () => ({}))

const queryAccessibleModel = vi.fn()
vi.mock('@/lib/bim/model-service', () => ({
  queryAccessibleModel: (...args: unknown[]) => queryAccessibleModel(...args),
}))

import {
  BIM_QUERY_LIMIT,
  DEFAULT_MUTATION_LIMIT,
  createInProcessStore,
  enforceLimit,
  memberSubject,
  setLimitStore,
} from '@/lib/limits'
import { POST } from './route'

const MODEL_ID = '11111111-2222-3333-4444-555555555555'

let orgCounter = 0
function session() {
  return {
    userId: 'user_me',
    organizationId: `org_${++orgCounter}`,
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
  }
}

function post() {
  return POST(
    new Request(`https://grid.test/api/bim/models/${MODEL_ID}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'elements', filter: {}, limit: 1000, offset: 0 }),
    }),
    { params: Promise.resolve({ modelId: MODEL_ID }) }
  )
}

beforeEach(() => {
  setLimitStore(createInProcessStore())
  requireAuthorizedSession.mockReset()
  queryAccessibleModel.mockReset().mockResolvedValue({ op: 'elements', elements: [] })
})

afterEach(() => {
  setLimitStore(null)
})

describe('POST /api/bim/models/[modelId]/query — rate limiting', () => {
  it('still answers when the mutation budget is exhausted', async () => {
    // The exact staging failure, from the other end: spend everything the
    // upload route spends, then read a model. A shared bucket makes this 429.
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)
    const subject = memberSubject(current)

    let drained = false
    for (let i = 0; i < DEFAULT_MUTATION_LIMIT.limit + 5; i += 1) {
      try {
        await enforceLimit(DEFAULT_MUTATION_LIMIT, subject)
      } catch {
        drained = true
        break
      }
    }
    expect(drained, 'the mutation bucket should be exhaustible').toBe(true)

    const response = await post()

    expect(response.status).toBe(200)
    expect(queryAccessibleModel).toHaveBeenCalled()
  })

  it('is still bounded — its own bucket refuses, naming its own policy', async () => {
    // Separate is not unlimited. Past the burst clause this route refuses, and
    // says which rule did it so a 429 stays diagnosable.
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)

    let refused: Response | null = null
    for (let i = 0; i < BIM_QUERY_LIMIT.limit + 50; i += 1) {
      const response = await post()
      if (response.status === 429) {
        refused = response
        break
      }
    }

    expect(refused, 'the bim-query bucket should be exhaustible too').not.toBeNull()
    expect(await refused!.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { policy: BIM_QUERY_LIMIT.name },
    })
  })

  it('does not spend the mutation budget an upload needs', async () => {
    // The invariant stated directly: reading a model leaves the upload route's
    // budget untouched.
    const current = session()
    requireAuthorizedSession.mockResolvedValue(current)
    const subject = memberSubject(current)

    for (let i = 0; i < 30; i += 1) await post()

    // 30 mutations would already be most of the burst clause; none were spent.
    await expect(enforceLimit(DEFAULT_MUTATION_LIMIT, subject)).resolves.not.toThrow()
  })
})
