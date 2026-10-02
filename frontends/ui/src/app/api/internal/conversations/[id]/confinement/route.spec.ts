/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn((_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/conversations/repository', () => ({
  findConversationTenancy: vi.fn(),
  recordRestrictedTurn: vi.fn(),
  withdrawFreshRestrictedTurn: vi.fn(),
}))
vi.mock('@/lib/sharing/repository', () => ({ countGrantsForResource: vi.fn() }))

import {
  findConversationTenancy,
  recordRestrictedTurn,
  withdrawFreshRestrictedTurn,
} from '@/lib/conversations/repository'
import { withTenant } from '@/lib/db/tenant-context'
import { countGrantsForResource } from '@/lib/sharing/repository'
import { POST } from './route'

const TOKEN = 'a-real-secret-token'
const CONVERSATION_ID = 's_7d1e2c3b_0000_4000_8000_00000000000c'
const ORG_ID = 'org_1'
const ASKER = 'user_me'

type Tenancy = NonNullable<Awaited<ReturnType<typeof findConversationTenancy>>>

const thread = (overrides: Partial<Tenancy> = {}): Tenancy => ({
  organizationId: ORG_ID,
  projectId: null,
  visibility: 'private',
  createdBy: ASKER,
  deletedAt: null,
  ...overrides,
})

const ask = (
  body: unknown = { organizationId: ORG_ID, userId: ASKER },
  token: string | undefined = TOKEN,
  id: string = CONVERSATION_ID
) =>
  POST(
    new Request(`https://grid.test/api/internal/conversations/${id}/confinement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )

const confinedOf = async (response: Response): Promise<boolean> => {
  expect(response.status).toBe(200)
  return ((await response.json()) as { confined: boolean }).confined
}

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
  vi.mocked(findConversationTenancy).mockResolvedValue(thread())
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(recordRestrictedTurn).mockResolvedValue({ created: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/conversations/[id]/confinement', () => {
  it("answers yes for the asker's own private thread without grants, in the asker's organization", async () => {
    expect(await confinedOf(await ask())).toBe(true)
    expect(vi.mocked(withTenant).mock.calls[0][0]).toEqual({ organizationId: ORG_ID })
    expect(countGrantsForResource).toHaveBeenCalledWith('conversation', CONVERSATION_ID)
  })

  it('answers yes for a thread the first message has not created yet', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    expect(await confinedOf(await ask())).toBe(true)
  })

  it('answers no once the owner has granted someone the thread', async () => {
    vi.mocked(countGrantsForResource).mockResolvedValue(1)

    expect(await confinedOf(await ask())).toBe(false)
  })

  it('answers no once the thread is visible to the project', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(thread({ visibility: 'project' }))

    expect(await confinedOf(await ask())).toBe(false)
  })

  it("answers no for someone else's thread", async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(thread({ createdBy: 'user_colleague' }))

    expect(await confinedOf(await ask())).toBe(false)
  })

  it('answers no for a thread of another organization', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(thread({ organizationId: 'org_other' }))

    expect(await confinedOf(await ask())).toBe(false)
  })

  it('refuses a caller without the internal token, and marks nothing', async () => {
    expect((await ask(undefined, 'wrong-token')).status).toBe(403)
    expect(findConversationTenancy).not.toHaveBeenCalled()
    expect(recordRestrictedTurn).not.toHaveBeenCalled()
  })

  it('refuses a body without the asker, and marks nothing', async () => {
    expect((await ask({ organizationId: ORG_ID })).status).toBe(400)
    expect(findConversationTenancy).not.toHaveBeenCalled()
    expect(recordRestrictedTurn).not.toHaveBeenCalled()
  })

  it('refuses an id too long to be a conversation, and marks nothing', async () => {
    expect((await ask(undefined, TOKEN, `s_${'a'.repeat(200)}`)).status).toBe(400)
    expect(recordRestrictedTurn).not.toHaveBeenCalled()
  })
})

describe('the confinement ask admits the turn and marks the conversation (ADR-0078)', () => {
  it('marks the conversation in the signed organization before it answers yes', async () => {
    expect(await confinedOf(await ask())).toBe(true)

    expect(recordRestrictedTurn).toHaveBeenCalledWith(CONVERSATION_ID, ORG_ID)
    expect(withdrawFreshRestrictedTurn).not.toHaveBeenCalled()
  })

  it('marks a thread the first message has not created yet: the first turn is the one that streams unseen', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    expect(await confinedOf(await ask())).toBe(true)
    expect(recordRestrictedTurn).toHaveBeenCalledWith(CONVERSATION_ID, ORG_ID)
  })

  it('writes the mark BEFORE it reads whether the thread is still private', async () => {
    // The sharing service writes first and re-reads the mark second; the race
    // is closed only if this side is the mirror image.
    await ask()

    const marked = vi.mocked(recordRestrictedTurn).mock.invocationCallOrder[0]
    const read = vi.mocked(countGrantsForResource).mock.invocationCallOrder[0]
    expect(marked).toBeLessThan(read)
  })

  it('withdraws a mark it just created when the answer is no', async () => {
    vi.mocked(countGrantsForResource).mockResolvedValue(1)

    expect(await confinedOf(await ask())).toBe(false)
    expect(withdrawFreshRestrictedTurn).toHaveBeenCalledWith(CONVERSATION_ID, ORG_ID)
  })

  it('keeps a mark an earlier turn wrote when the answer is no', async () => {
    vi.mocked(recordRestrictedTurn).mockResolvedValue({ created: false })
    vi.mocked(findConversationTenancy).mockResolvedValue(thread({ visibility: 'project' }))

    expect(await confinedOf(await ask())).toBe(false)
    expect(withdrawFreshRestrictedTurn).not.toHaveBeenCalled()
  })

  it("does not leave a mark on someone else's thread", async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(thread({ createdBy: 'user_colleague' }))

    expect(await confinedOf(await ask())).toBe(false)
    expect(withdrawFreshRestrictedTurn).toHaveBeenCalledWith(CONVERSATION_ID, ORG_ID)
  })
})
