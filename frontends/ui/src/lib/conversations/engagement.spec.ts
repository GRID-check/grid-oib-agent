/**
 * The engagement mode (ADR-0036) — when the agent answers a message that tags
 * nobody.
 *
 * What matters here is that the answer comes from **structure we hold**, never
 * from a judgement about what a message meant. So these tests are about counting
 * people and about not overwriting a choice someone made, which is the whole of
 * the mechanism.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ getDb: () => mockDb }))

import {
  countDistinctHumanAuthors,
  deriveEngagement,
  findStoredEngagement,
  persistDerivedEngagement,
  resolveEngagement,
} from './engagement'

/** `select().from().where()` resolving to `rows`, and `.limit()` where used. */
const stubSelect = (rows: unknown[]) => {
  const chain = {
    from: () => chain,
    where: () => Object.assign(Promise.resolve(rows), chain),
    limit: () => Promise.resolve(rows),
  }
  mockDb.select.mockReturnValue(chain)
}

/** `update().set().where().returning()` resolving to `rows`. */
const stubUpdate = (rows: unknown[]) => {
  const chain = {
    set: () => chain,
    where: () => chain,
    returning: () => Promise.resolve(rows),
  }
  mockDb.update.mockReturnValue(chain)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deriveEngagement', () => {
  it('is ask for a thread one person has written in', () => {
    expect(deriveEngagement(0)).toBe('ask')
    expect(deriveEngagement(1)).toBe('ask')
  })

  it('is mention once a second person has written', () => {
    // The structural signal, and the whole rule: a thread two people write in is
    // a conversation between people, so a plain sentence stops being assumed to
    // be a question for the assistant.
    expect(deriveEngagement(2)).toBe('mention')
    expect(deriveEngagement(7)).toBe('mention')
  })
})

describe('countDistinctHumanAuthors', () => {
  it('reads the distinct-author count', async () => {
    stubSelect([{ count: 3 }])
    await expect(countDistinctHumanAuthors('conv_1')).resolves.toBe(3)
  })

  it('treats an empty thread as nobody rather than throwing', async () => {
    stubSelect([])
    await expect(countDistinctHumanAuthors('conv_1')).resolves.toBe(0)
  })
})

describe('resolveEngagement', () => {
  it('obeys a stored mode without counting anything', async () => {
    await expect(resolveEngagement('conv_1', 'mention')).resolves.toEqual({
      mode: 'mention',
      stored: 'mention',
    })
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('derives when nothing is stored, and says that it derived', async () => {
    // `stored: null` is what tells a UI "this is not a choice anyone made yet",
    // and what stops the settle step from overwriting a real choice.
    stubSelect([{ count: 2 }])
    await expect(resolveEngagement('conv_1', null)).resolves.toEqual({
      mode: 'mention',
      stored: null,
    })
  })

  it('a stored ask survives a thread full of people — a choice outranks the rule', async () => {
    stubSelect([{ count: 5 }])
    await expect(resolveEngagement('conv_1', 'ask')).resolves.toEqual({
      mode: 'ask',
      stored: 'ask',
    })
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('findStoredEngagement', () => {
  it('returns the column, and null for a thread that has none', async () => {
    stubSelect([{ engagement: 'mention' }])
    await expect(findStoredEngagement('conv_1')).resolves.toBe('mention')

    stubSelect([{ engagement: null }])
    await expect(findStoredEngagement('conv_1')).resolves.toBeNull()

    stubSelect([])
    await expect(findStoredEngagement('conv_1')).resolves.toBeNull()
  })
})

describe('persistDerivedEngagement', () => {
  it('reports whether THIS call performed the flip', async () => {
    // The caller announces the transition, so "did I do it?" has to be the return
    // value rather than something inferred — two participants writing at once
    // must not announce it twice.
    stubUpdate([{ id: 'conv_1' }])
    await expect(persistDerivedEngagement('conv_1', 'mention')).resolves.toBe(true)

    // The guard is `engagement IS NULL` in SQL, so a row that already has a mode
    // updates nothing and the second caller learns it lost the race.
    stubUpdate([])
    await expect(persistDerivedEngagement('conv_1', 'mention')).resolves.toBe(false)
  })
})
