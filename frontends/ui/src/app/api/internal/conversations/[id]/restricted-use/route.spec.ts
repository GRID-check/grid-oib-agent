/**
 * @vitest-environment node
 *
 * The agent's two questions about restricted folders (ADR-0087, ADR-0088):
 * which candidates a turn may draw on, and the admission that records a use.
 * The rule itself is `restricted-use.spec.ts` and, against Postgres,
 * `restricted-use.integration.spec.ts`; here, that the route asks it in the
 * stated organization, answers in the agent's shape, and holds its bounds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn((_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/conversations/restricted-use', () => ({
  ADMISSION_MAX_COLLECTIONS: 20,
  admitRestrictedUse: vi.fn(),
  drawableRestrictedCollections: vi.fn(),
  markTurnAnswer: vi.fn(),
  recordedRestrictedFolders: vi.fn(),
}))

import {
  admitRestrictedUse,
  drawableRestrictedCollections,
  markTurnAnswer,
  recordedRestrictedFolders,
} from '@/lib/conversations/restricted-use'
import { withTenant } from '@/lib/db/tenant-context'
import { POST } from './route'

const TOKEN = 'a-real-secret-token'
const CONVERSATION_ID = 's_7d1e2c3b_0000_4000_8000_00000000000c'
const ORG_ID = 'org_1'
const ASKER = 'user_me'
const VERTRAEGE = 'proj_abc_r0123456789ab'

const ask = (body: unknown, token: string = TOKEN, id: string = CONVERSATION_ID) =>
  POST(
    new Request(`https://grid.test/api/internal/conversations/${id}/restricted-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': token },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )

const ANSWER_ID = '0b7c6d2e-5f1a-5c3b-9d4e-8f7a6b5c4d3e'
const REQUEST = {
  organizationId: ORG_ID,
  conversationId: CONVERSATION_ID,
  userId: ASKER,
  projectId: 'proj-1',
  answerMessageId: null,
}

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
  vi.mocked(drawableRestrictedCollections).mockResolvedValue([VERTRAEGE])
  vi.mocked(recordedRestrictedFolders).mockResolvedValue(['folder-vertraege'])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/conversations/[id]/restricted-use', () => {
  it('answers a turn start with what may be drawn on and the folders already recorded, in the stated organization', async () => {
    const response = await ask({ organizationId: ORG_ID, userId: ASKER, projectId: 'proj-1', candidates: [VERTRAEGE] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      drawable: [VERTRAEGE],
      admitted: [],
      refused: [],
      recorded: ['folder-vertraege'],
    })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: ORG_ID }, expect.any(Function))
    expect(drawableRestrictedCollections).toHaveBeenCalledWith(REQUEST, [VERTRAEGE])
    expect(recordedRestrictedFolders).toHaveBeenCalledWith(CONVERSATION_ID, ORG_ID)
    expect(admitRestrictedUse).not.toHaveBeenCalled()
  })

  it('admits a tool round’s collections and hands back the admission', async () => {
    vi.mocked(admitRestrictedUse).mockResolvedValue({
      admitted: [VERTRAEGE],
      refused: [],
      recorded: ['folder-vertraege'],
    })

    const response = await ask({ organizationId: ORG_ID, userId: ASKER, projectId: 'proj-1', admit: [VERTRAEGE] })

    expect(await response.json()).toEqual({
      drawable: [VERTRAEGE],
      admitted: [VERTRAEGE],
      refused: [],
      recorded: ['folder-vertraege'],
    })
    expect(admitRestrictedUse).toHaveBeenCalledWith(REQUEST, [VERTRAEGE])
  })

  /**
   * The answer id is the server's key for the mark (ADR-0092): the turn start
   * marks it when an earlier turn drew on a restricted folder, the admission in
   * the transaction that records the folder. Both before the model reads.
   */
  it('hands the answer the turn writes to the mark, at turn start and at admission', async () => {
    vi.mocked(admitRestrictedUse).mockResolvedValue({ admitted: [VERTRAEGE], refused: [], recorded: [] })
    const withAnswer = { ...REQUEST, answerMessageId: ANSWER_ID }

    await ask({ organizationId: ORG_ID, userId: ASKER, projectId: 'proj-1', candidates: [VERTRAEGE], answerMessageId: ANSWER_ID })
    expect(markTurnAnswer).toHaveBeenCalledWith(withAnswer)

    await ask({ organizationId: ORG_ID, userId: ASKER, projectId: 'proj-1', admit: [VERTRAEGE], answerMessageId: ANSWER_ID })
    expect(admitRestrictedUse).toHaveBeenCalledWith(withAnswer, [VERTRAEGE])
  })

  it('refuses an answer id that is not one the agent mints', async () => {
    const response = await ask({ organizationId: ORG_ID, userId: ASKER, admit: [VERTRAEGE], answerMessageId: 'not-a-uuid' })
    expect(response.status).toBe(400)
    expect(admitRestrictedUse).not.toHaveBeenCalled()
  })

  it('refuses a caller without the internal token, and asks nothing', async () => {
    const response = await ask({ organizationId: ORG_ID, userId: ASKER, candidates: [VERTRAEGE] }, 'wrong-token')
    expect(response.status).toBe(403)
    expect(drawableRestrictedCollections).not.toHaveBeenCalled()
  })

  it('refuses an asker it was not told, and an id too long to record', async () => {
    expect((await ask({ organizationId: ORG_ID, candidates: [VERTRAEGE] })).status).toBe(400)
    expect((await ask({ organizationId: ORG_ID, userId: ASKER }, TOKEN, 's_'.padEnd(129, 'x'))).status).toBe(400)
    expect(admitRestrictedUse).not.toHaveBeenCalled()
  })

  it('bounds how many collections one call may name', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `proj_abc_r${String(i).padStart(12, '0')}`)
    expect((await ask({ organizationId: ORG_ID, userId: ASKER, admit: many })).status).toBe(400)
  })
})
