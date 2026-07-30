import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('./repository', () => ({ listFeedbackTurns: vi.fn() }))

import { setCacheStore, type CacheStore } from '@/lib/cache'
import { listFeedbackTurns } from './repository'
import type { FeedbackHealth } from './repository'
import { getFeedbackDigest } from './digest'

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
    windowDays: 30,
    answers: 500,
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
      {},
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
      {},
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
    await getFeedbackDigest(health(), {})

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

    await getFeedbackDigest(health(), {})

    const serialised = JSON.stringify(sentBody())
    expect(serialised).toContain('Wie lang darf ein Fluchtweg sein?')
    expect(serialised).not.toContain('A LONG GENERATED ANSWER')
    // …and no user, conversation or message identifiers either.
    expect(serialised).not.toContain('org_loud')
    expect(serialised).not.toContain('m1')
  })

  /**
   * `health.turns` holds whichever direction the reader is looking at. A digest
   * that sampled only that would write a different story depending on which tab
   * happened to be open, so it fetches both halves itself.
   */
  it('samples both directions regardless of which one the page is showing', async () => {
    await getFeedbackDigest(health(), { verdict: 'down' })

    const verdicts = vi
      .mocked(listFeedbackTurns)
      .mock.calls.map((call) => (call[0] as { verdict?: string }).verdict)
    expect(verdicts.sort()).toEqual(['down', 'up'])
  })
})

describe('getFeedbackDigest — caching', () => {
  beforeEach(() => {
    backendReply({ headline: 'Mostly fine.', strengths: ['a'], concerns: ['b'] })
  })

  it('asks the model once and serves the rest from the cache', async () => {
    const first = await getFeedbackDigest(health(), { windowDays: 30 })
    const second = await getFeedbackDigest(health(), { windowDays: 30 })

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    expect(second.digest?.generatedAt).toBe(first.digest?.generatedAt)
  })

  it('keys on the window and the aggregate filters, not on the drill-in ones', async () => {
    // The drill-in direction and the reason narrow the LIST; the digest describes
    // the window. Keying on them would buy four copies of the same paragraph.
    await getFeedbackDigest(health(), { windowDays: 30, verdict: 'down', reason: 'inaccurate' })
    await getFeedbackDigest(health(), { windowDays: 30, verdict: 'up', reason: null })
    expect(globalThis.fetch).toHaveBeenCalledOnce()

    // A different window IS a different digest.
    await getFeedbackDigest({ ...health(), windowDays: 7 }, { windowDays: 7 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('re-asks when the reader presses refresh', async () => {
    await getFeedbackDigest(health(), { windowDays: 30 })
    await getFeedbackDigest(health(), { windowDays: 30 }, { refresh: true })

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('getFeedbackDigest — failure', () => {
  it('reports a backend error instead of an empty digest that looks considered', async () => {
    backendReply({ error: 'llm_not_configured' })
    const result = await getFeedbackDigest(health(), {})

    expect(result).toEqual({ digest: null, error: 'llm_not_configured' })
  })

  it('survives an unreachable backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )

    await expect(getFeedbackDigest(health(), {})).resolves.toEqual({
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
    await getFeedbackDigest(health(), {})

    const cached = [...store.entries.values()]
    expect(cached).toEqual(['null'])

    backendReply({ headline: 'Now it works.', strengths: [], concerns: [] })
    // A minute later the entry is gone; simulated by dropping it, since the
    // memory store here does not implement expiry.
    store.entries.clear()
    const second = await getFeedbackDigest(health(), {})
    expect(second.digest?.headline).toBe('Now it works.')
  })
})
