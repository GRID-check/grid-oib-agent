import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('./repository', () => ({ listFeedbackTurns: vi.fn() }))

import { setCacheStore, type CacheStore } from '@/lib/cache'
import { listFeedbackTurns } from './repository'
import type { FeedbackHealth } from './repository'
import { getFeedbackDigest } from './digest'
import { NO_RATINGS_FILTERS, type FeedbackQuery, type RatingsFilters } from './filters'

/** Every vote of the 30 days the health fixture describes. */
const Q: FeedbackQuery = {
  scope: { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] },
  ratings: NO_RATINGS_FILTERS,
}
const narrowed = (ratings: Partial<RatingsFilters>, scope: Partial<FeedbackQuery['scope']> = {}): FeedbackQuery => ({
  scope: { ...Q.scope, ...scope },
  ratings: { ...NO_RATINGS_FILTERS, ...ratings },
})

/** A real store, so cache behaviour is exercised rather than mocked away. */
class MemoryStore implements CacheStore {
  entries = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.entries.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key)
  }
}

let store: MemoryStore

const health = (overrides: Partial<FeedbackHealth> = {}): FeedbackHealth =>
  ({
    from: '2026-09-10',
    to: '2026-10-09',
    windowDays: 30,
    answers: 500,
    ratedAnswers: 45,
    coverage: 0.09,
    totals: { up: 40, down: 10, voters: 12, downVoters: 4 },
    reasons: [{ reason: 'inaccurate', count: 7 }],
    daily: [],
    organizations: [
      { organizationId: 'org_loud', up: 5, down: 9, voters: 2 },
      { organizationId: 'org_quiet', up: 35, down: 1, voters: 10 },
    ],
    topics: [{ topic: 'brandschutz', up: 20, down: 6, voters: 8 }],
    turns: [],
    ...overrides,
  }) as FeedbackHealth

const backendReply = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  )
}

const sentBody = (): Record<string, unknown> =>
  JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body ?? '{}'))

beforeEach(() => {
  vi.clearAllMocks()
  store = new MemoryStore()
  setCacheStore(store)
  vi.mocked(listFeedbackTurns).mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getFeedbackDigest — when there is nothing to say', () => {
  it('does not call the model for an empty window', async () => {
    backendReply({})
    const result = await getFeedbackDigest(
      health({ totals: { up: 0, down: 0, voters: 0, downVoters: 0 } }),
      Q,
    )

    expect(result).toEqual({ digest: null, error: 'no_feedback' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  /**
   * A paragraph about six votes reads exactly as confidently as a paragraph
   * about six hundred, and that confidence is the problem. Refused outright
   * rather than hedged in the prompt — a hedge is still a paragraph.
   */
  it('refuses a window too thin to summarise, without asking', async () => {
    backendReply({})
    const result = await getFeedbackDigest(
      health({ totals: { up: 4, down: 2, voters: 3, downVoters: 2 } }),
      Q,
    )

    expect(result).toEqual({ digest: null, error: 'too_few_votes' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('getFeedbackDigest — what leaves the process', () => {
  beforeEach(() => {
    backendReply({ headline: 'Mostly fine.', strengths: ['a'], concerns: ['b'], recommendation: 'c' })
  })

  /**
   * The privacy line of this feature. The digest needs the SHAPE of the
   * distribution — "one tenant accounts for most of it" — and never the
   * identity; the table under it names them on screen anyway. Stripped at this
   * boundary so no later edit to the rollup can widen what is sent.
   */
  it('sends organization vote counts without organization identifiers', async () => {
    await getFeedbackDigest(health(), Q)

    const body = sentBody()
    expect(body.organizations).toEqual([
      { up: 5, down: 9 },
      { up: 35, down: 1 },
    ])
    expect(JSON.stringify(body)).not.toContain('org_loud')
    expect(JSON.stringify(body)).not.toContain('org_quiet')
  })

  it('sends questions but never the generated answers', async () => {
    vi.mocked(listFeedbackTurns).mockResolvedValue([
      {
        id: 'f1',
        organizationId: 'org_loud',
        projectId: null,
        conversationId: 'c1',
        messageId: 'm1',
        verdict: 'down',
        reason: 'inaccurate',
        createdAt: new Date(),
        answer: 'A LONG GENERATED ANSWER',
        question: 'Wie lang darf ein Fluchtweg sein?',
        conversationTitle: 'Flucht',
        topics: ['brandschutz'],
      },
    ] as never)

    await getFeedbackDigest(health(), Q)

    const serialised = JSON.stringify(sentBody())
    expect(serialised).toContain('Wie lang darf ein Fluchtweg sein?')
    expect(serialised).not.toContain('A LONG GENERATED ANSWER')
    // …and no user, conversation or message identifiers either.
    expect(serialised).not.toContain('org_loud')
    expect(serialised).not.toContain('m1')
  })

  /** ADR-0064 use 9: a down-vote's comment is what its cause is read from; an up-vote's is not sent. */
  it('sends a down-vote comment with its question, and carries the decided causes back', async () => {
    const turn = {
      id: 'f1',
      organizationId: 'org_loud',
      projectId: null,
      conversationId: 'c1',
      messageId: 'm1',
      createdAt: new Date(),
      answer: null,
      conversationTitle: null,
      topics: [],
    }
    vi.mocked(listFeedbackTurns).mockImplementation(async (_query, options) =>
      options?.verdict === 'up'
        ? ([{ ...turn, verdict: 'up', reason: null, question: 'U-Wert?', comment: 'super' }] as never)
        : ([{ ...turn, verdict: 'down', reason: 'inaccurate', question: 'GK 4?', comment: 'R 60, nicht R 90' }] as never),
    )
    backendReply({
      headline: 'Mostly fine.',
      strengths: ['a'],
      concerns: ['b'],
      causes: { wrong_value: 1, bogus: 'x', form: 0 },
    })

    const result = await getFeedbackDigest(health(), Q)

    const samples = sentBody().samples as { verdict: string; comment: string | null }[]
    expect(samples.find((s) => s.verdict === 'down')?.comment).toBe('R 60, nicht R 90')
    expect(samples.find((s) => s.verdict === 'up')?.comment).toBeNull()
    expect(result.digest?.causes).toEqual([{ cause: 'wrong_value', count: 1 }])
  })

  /**
   * Both directions are sampled separately, so the newest of one cannot crowd
   * out the other, and under the same filters as the figures.
   */
  it('samples both directions, each under the request’s filters', async () => {
    const query = narrowed({ topics: ['brandschutz'] }, { organizationIds: ['org_loud'] })
    await getFeedbackDigest(health(), query)

    const calls = vi.mocked(listFeedbackTurns).mock.calls
    expect(calls.map((call) => call[1]?.verdict).sort()).toEqual(['down', 'up'])
    for (const call of calls) expect(call[0]).toEqual(query)
  })
})

describe('getFeedbackDigest — caching', () => {
  beforeEach(() => {
    backendReply({ headline: 'Mostly fine.', strengths: ['a'], concerns: ['b'] })
  })

  it('asks the model once and serves the rest from the cache', async () => {
    const first = await getFeedbackDigest(health(), Q)
    const second = await getFeedbackDigest(health(), Q)

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    expect(second.digest?.generatedAt).toBe(first.digest?.generatedAt)
  })

  /**
   * The filters narrow the FIGURES now (a reason or a search changes the
   * headline), so each set of filters is its own digest; the same set in a
   * different order is not.
   */
  it('keys on the range, the organizations and every filter', async () => {
    await getFeedbackDigest(health(), narrowed({ reasons: ['inaccurate', 'other'] }))
    await getFeedbackDigest(health(), narrowed({ reasons: ['inaccurate', 'other'] }))
    expect(globalThis.fetch).toHaveBeenCalledOnce()

    await getFeedbackDigest(health(), narrowed({ reasons: ['inaccurate'] }))
    await getFeedbackDigest(health(), narrowed({}, { from: '2026-10-03' }))
    await getFeedbackDigest(health(), narrowed({}, { organizationIds: ['org_b', 'org_a'] }))
    await getFeedbackDigest(health(), narrowed({}, { organizationIds: ['org_a', 'org_b'] }))
    expect(globalThis.fetch).toHaveBeenCalledTimes(4)
  })

  it('names the organizations in the key, and `*` for the platform-wide digest', async () => {
    await getFeedbackDigest(health(), Q)
    await getFeedbackDigest(health(), narrowed({}, { organizationIds: ['org_b', 'org_a'] }))

    const keys = [...store.entries.keys()]
    expect(keys.some((k) => k.includes(':2026-09-10:2026-10-09:*:'))).toBe(true)
    expect(keys.some((k) => k.includes(':org_a,org_b:'))).toBe(true)
  })

  /**
   * A digest cached before the sampled turns left out restricted conversations
   * may restate one of their comments. It must not be served after the deploy
   * that leaves them out, for the rest of its six hours.
   */
  it('does not serve a digest cached before restricted votes were left out', async () => {
    // The key this query has today, then the same key one version back.
    await getFeedbackDigest(health(), Q)
    const [current] = [...store.entries.keys()]
    expect(current).toContain(':v3:')
    store.entries.clear()
    vi.mocked(globalThis.fetch).mockClear()
    const stale = { headline: 'Zimmerer-Honorar 48.000 EUR falsch.', strengths: [], concerns: [] }
    await store.set(current.replace(':v3:', ':v2:'), JSON.stringify(stale))

    const result = await getFeedbackDigest(health(), Q)

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    expect(result.digest?.headline).toBe('Mostly fine.')
  })

  it('re-asks when the reader presses refresh', async () => {
    await getFeedbackDigest(health(), Q)
    await getFeedbackDigest(health(), Q, { refresh: true })

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('getFeedbackDigest — failure', () => {
  it('reports a backend error instead of an empty digest that looks considered', async () => {
    backendReply({ error: 'llm_not_configured' })
    const result = await getFeedbackDigest(health(), Q)

    expect(result).toEqual({ digest: null, error: 'llm_not_configured' })
  })

  it('survives an unreachable backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )

    await expect(getFeedbackDigest(health(), Q)).resolves.toEqual({
      digest: null,
      error: 'backend_unreachable',
    })
  })

  /**
   * A failure must not be remembered for the digest's full TTL. Without the
   * short negative TTL one timeout leaves the card empty for the rest of the
   * working day, and the refresh button becomes the only way out of it.
   */
  it('does not cache a failure for the success TTL', async () => {
    backendReply({}, false)
    await getFeedbackDigest(health(), Q)

    const cached = [...store.entries.values()]
    expect(cached).toEqual(['null'])

    backendReply({ headline: 'Now it works.', strengths: [], concerns: [] })
    // A minute later the entry is gone; simulated by dropping it, since the
    // memory store here does not implement expiry.
    store.entries.clear()
    const second = await getFeedbackDigest(health(), Q)
    expect(second.digest?.headline).toBe('Now it works.')
  })
})
