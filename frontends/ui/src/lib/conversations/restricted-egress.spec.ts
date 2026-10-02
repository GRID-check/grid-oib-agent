/**
 * @vitest-environment node
 */
/**
 * What may leave a conversation that drew on a restricted folder (ADR-0078).
 *
 * The decision is driven here with the repository and the folder tree mocked:
 * which origins are confined, that a run, task or profile patch from one is
 * refused outright, and that a filing from one goes only where every reader is
 * cleared for every restricted folder of the project.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  hasRestrictedTurn: vi.fn(),
  listRestrictedAnswerCollections: vi.fn(),
}))
vi.mock('@/lib/authz/folder-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/folder-access')>()),
  currentRestrictedCollections: vi.fn(),
  restrictedCollectionsAbove: vi.fn(),
}))

import { ConversationConfinedError } from '@/lib/api/errors'
import { currentRestrictedCollections, restrictedCollectionsAbove } from '@/lib/authz/folder-access'
import { hasRestrictedTurn, listRestrictedAnswerCollections } from './repository'
import {
  isConversationConfined,
  requireMayFileFrom,
  requireMayLeaveConversation,
  restrictedCollectionsIn,
} from './restricted-egress'

const ORG = 'org_1'
const PROJECT = '3f8b0d2e-0000-4000-8000-000000000001'
const COLLECTION = 'proj_3f8b0d2e'
const VERTRAEGE = `${COLLECTION}_r0123456789ab`
const HONORARE = `${COLLECTION}_rba9876543210`
const CONV = 's_conv_1'

const destination = (folderId: string | null) => ({
  organizationId: ORG,
  projectId: PROJECT,
  projectCollection: COLLECTION,
  folderId,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasRestrictedTurn).mockResolvedValue(false)
  vi.mocked(listRestrictedAnswerCollections).mockResolvedValue([])
  vi.mocked(currentRestrictedCollections).mockResolvedValue([VERTRAEGE])
  vi.mocked(restrictedCollectionsAbove).mockResolvedValue([])
})

async function refusal(promise: Promise<unknown>): Promise<ConversationConfinedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ConversationConfinedError)
  return error as ConversationConfinedError
}

describe('isConversationConfined — the one predicate, shared with the share refusal', () => {
  it('is false for a conversation with no mark and no restricted answer', async () => {
    expect(await isConversationConfined(CONV, ORG)).toBe(false)
  })

  it('is true for a conversation marked at turn start', async () => {
    vi.mocked(hasRestrictedTurn).mockResolvedValue(true)
    expect(await isConversationConfined(CONV, ORG)).toBe(true)
  })

  it('is true for one whose stored answers cite or read a restricted collection', async () => {
    vi.mocked(listRestrictedAnswerCollections).mockResolvedValue([VERTRAEGE])
    expect(await isConversationConfined(CONV, ORG)).toBe(true)
  })
})

describe('requireMayLeaveConversation — runs, tasks and the profile', () => {
  it.each(['deepResearch', 'task', 'profilePatch'] as const)('refuses %s from a marked conversation', async (action) => {
    vi.mocked(hasRestrictedTurn).mockResolvedValue(true)
    const error = await refusal(requireMayLeaveConversation({ conversationId: CONV, locale: 'de' }, ORG, action))
    expect(error.status).toBe(403)
    expect(error.code).toBe('CONVERSATION_CONFINED')
    expect(error.details).toEqual({ action })
    expect(error.message).toContain('Ordner mit eingeschränktem Zugriff')
  })

  it('refuses on the signed scope alone, without reading the conversation', async () => {
    await refusal(
      requireMayLeaveConversation(
        { conversationId: null, signedRestrictedCollections: [VERTRAEGE], locale: 'en' },
        ORG,
        'task'
      )
    )
    expect(hasRestrictedTurn).not.toHaveBeenCalled()
  })

  it('speaks the reader’s language', async () => {
    vi.mocked(hasRestrictedTurn).mockResolvedValue(true)
    const error = await refusal(
      requireMayLeaveConversation({ conversationId: CONV, locale: 'en' }, ORG, 'deepResearch')
    )
    expect(error.message).toContain('folder with restricted access')
    expect(error.message).toContain('deep research')
  })

  it('lets an open conversation through', async () => {
    await expect(
      requireMayLeaveConversation({ conversationId: CONV, locale: 'de' }, ORG, 'deepResearch')
    ).resolves.toBeUndefined()
  })
})

describe('requireMayFileFrom — only into a folder restricted at least as narrowly', () => {
  beforeEach(() => vi.mocked(hasRestrictedTurn).mockResolvedValue(true))

  it('refuses an open folder', async () => {
    const error = await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('open')))
    expect(error.details).toEqual({ action: 'filing' })
  })

  it('refuses a folder that would be created open at the root', async () => {
    await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination(null)))
  })

  it('allows the restricted folder itself, and a folder below it', async () => {
    vi.mocked(restrictedCollectionsAbove).mockResolvedValue([VERTRAEGE])
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('vertraege'))
    ).resolves.toBeUndefined()
    vi.mocked(restrictedCollectionsAbove).mockResolvedValue([HONORARE, VERTRAEGE])
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('honorare'))
    ).resolves.toBeUndefined()
  })

  it('refuses a sibling restricted folder: its readers need not be cleared for the other one', async () => {
    vi.mocked(currentRestrictedCollections).mockResolvedValue([VERTRAEGE, HONORARE])
    vi.mocked(restrictedCollectionsAbove).mockResolvedValue([VERTRAEGE])
    await refusal(requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('vertraege')))
  })

  it('allows anything once the project restricts nothing any more', async () => {
    vi.mocked(currentRestrictedCollections).mockResolvedValue([])
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('open'))
    ).resolves.toBeUndefined()
  })

  it('refuses a destination outside every project (the Archiv)', async () => {
    await refusal(
      requireMayFileFrom(
        { conversationId: CONV, locale: 'de' },
        { ...destination('archiv'), projectId: null, projectCollection: 'archiv_org_1' }
      )
    )
  })

  it('lets an open conversation file anywhere, without reading the folder tree', async () => {
    vi.mocked(hasRestrictedTurn).mockResolvedValue(false)
    await expect(
      requireMayFileFrom({ conversationId: CONV, locale: 'de' }, destination('open'))
    ).resolves.toBeUndefined()
    expect(currentRestrictedCollections).not.toHaveBeenCalled()
  })
})

describe('restrictedCollectionsIn', () => {
  it('keeps only the restricted folders’ collections of a signed scope', () => {
    expect(restrictedCollectionsIn(['oib_knowledge', COLLECTION, VERTRAEGE, 's_conv_1'])).toEqual([VERTRAEGE])
  })
})
