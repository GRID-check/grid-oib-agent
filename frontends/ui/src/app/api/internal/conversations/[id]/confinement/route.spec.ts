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
vi.mock('@/lib/conversations/repository', () => ({ findConversationTenancy: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({ countGrantsForResource: vi.fn() }))

import { findConversationTenancy } from '@/lib/conversations/repository'
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

const ask = (body: unknown = { organizationId: ORG_ID, userId: ASKER }, token: string | undefined = TOKEN) =>
  POST(
    new Request(`https://grid.test/api/internal/conversations/${CONVERSATION_ID}/confinement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CONVERSATION_ID }) }
  )

const confinedOf = async (response: Response): Promise<boolean> => {
  expect(response.status).toBe(200)
  return ((await response.json()) as { confined: boolean }).confined
}

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
  vi.mocked(findConversationTenancy).mockResolvedValue(thread())
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
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

  it('refuses a caller without the internal token', async () => {
    expect((await ask(undefined, 'wrong-token')).status).toBe(403)
    expect(findConversationTenancy).not.toHaveBeenCalled()
  })

  it('refuses a body without the asker', async () => {
    expect((await ask({ organizationId: ORG_ID })).status).toBe(400)
    expect(findConversationTenancy).not.toHaveBeenCalled()
  })
})
