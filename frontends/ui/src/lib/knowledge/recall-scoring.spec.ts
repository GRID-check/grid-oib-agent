import { describe, expect, it } from 'vitest'
import {
  RECENCY_DECAY,
  fuseHybridRelevance,
  REINFORCEMENT_MAX,
  REINFORCEMENT_MIN,
  daysSince,
  rankByRecallScore,
  reinforcementMultiplier,
} from './recall-scoring'

const note = (overrides: Partial<Parameters<typeof rankByRecallScore>[0][number]> = {}) => ({
  relevance: null,
  importance: 0.5,
  daysSinceUse: null,
  timesUsed: 0,
  ...overrides,
})

describe('reinforcementMultiplier', () => {
  it('does not punish a note that has never been recalled', () => {
    // Otherwise the store is self-confirming: only what was already surfaced
    // could ever be surfaced again.
    expect(reinforcementMultiplier(null, 0)).toBe(1)
  })

  it('boosts a freshly used note and dampens a long-unused one', () => {
    expect(reinforcementMultiplier(0, 0)).toBeCloseTo(REINFORCEMENT_MAX)
    expect(reinforcementMultiplier(365, 0)).toBeCloseTo(REINFORCEMENT_MIN)
  })

  it('flattens the curve as use accumulates (MemoryBank S += 1)', () => {
    // Same elapsed time, more past recalls => retained better.
    expect(reinforcementMultiplier(5, 10)).toBeGreaterThan(reinforcementMultiplier(5, 0))
  })

  it('stays inside the published band for any input', () => {
    for (const [days, used] of [
      [0, 0],
      [1, 1],
      [1000, 0],
      [10, 100],
    ] as const) {
      const value = reinforcementMultiplier(days, used)
      expect(value).toBeGreaterThanOrEqual(REINFORCEMENT_MIN)
      expect(value).toBeLessThanOrEqual(REINFORCEMENT_MAX)
    }
  })
})

describe('rankByRecallScore', () => {
  it('is relevance-dominant — a relevant note outranks a merely recent one', () => {
    // Input order IS the recency signal (index 0 is most recent).
    const ranked = rankByRecallScore([
      note({ relevance: 0.1 }), // most recent, barely relevant
      note({ relevance: 0.9 }), // older, clearly relevant
    ])
    expect(ranked[0].index).toBe(1)
  })

  it('falls back to importance and recency when nothing is embedded', () => {
    const ranked = rankByRecallScore([
      note({ relevance: null, importance: 0.1 }),
      note({ relevance: null, importance: 0.9 }),
    ])
    expect(ranked[0].index).toBe(1)
  })

  it('breaks a flat field by recency, most recent first', () => {
    const ranked = rankByRecallScore([note(), note(), note()])
    expect(ranked.map((entry) => entry.index)).toEqual([0, 1, 2])
  })

  it('lets sustained use break a tie the relevance term cannot', () => {
    // Equal relevance, so the normalised relevance term is flat for everyone
    // and reinforcement is what is left to decide it.
    const ranked = rankByRecallScore([
      note({ relevance: 0.5, daysSinceUse: 400, timesUsed: 0 }),
      note({ relevance: 0.5, daysSinceUse: 0, timesUsed: 20 }),
    ])
    expect(ranked[0].index).toBe(1)
  })

  it('amplifies small relevance gaps in a SMALL candidate set (known property)', () => {
    // Min-max normalisation is relative to the candidate set, so with two
    // candidates a 0.05 cosine difference becomes the entire spread: 1 vs 0.
    // That is the published design (Generative Agents normalises across the
    // retrieved set) and it is harmless at the real candidate count — recall
    // scores up to RECALL_CANDIDATE_LIMIT rows — but it is pinned here so
    // nobody debugs it twice as a bug.
    const ranked = rankByRecallScore([
      note({ relevance: 0.55, daysSinceUse: 400, timesUsed: 0 }),
      note({ relevance: 0.5, daysSinceUse: 0, timesUsed: 20 }),
    ])
    expect(ranked[0].index).toBe(0)
  })

  it('returns every candidate, never a truncated set', () => {
    expect(rankByRecallScore([note(), note(), note()])).toHaveLength(3)
    expect(rankByRecallScore([])).toEqual([])
  })

  it('uses the shipped decay base rather than the paper value', () => {
    // The released Generative Agents code uses 0.99; the paper says 0.995.
    expect(RECENCY_DECAY).toBe(0.99)
  })
})

describe('daysSince', () => {
  it('is null for a note never recalled, and non-negative otherwise', () => {
    expect(daysSince(null)).toBeNull()
    expect(daysSince(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))).toBeCloseTo(2, 1)
    // A clock skew into the future must not produce a negative age.
    expect(daysSince(new Date(Date.now() + 60_000))).toBe(0)
  })
})

describe('fuseHybridRelevance', () => {
  it('lets the lexical channel rescue an exact identifier the embedding missed', () => {
    // "§ 4 Abs. 2" style: dense ranks the wrong note first, lexical overlap
    // ranks the note that carries the literal token. Fused, the token match
    // is competitive rather than invisible.
    const fused = fuseHybridRelevance([0.8, 0.4], [0, 0.9])
    expect(fused[0]).not.toBeNull()
    // The rescued note holds rank 1 lexically AND rank 2 densely, so it sums
    // contributions from both channels and overtakes the dense-only leader —
    // agreement between channels is rewarded, disagreement is survivable.
    expect(fused[1]).toBeGreaterThan(fused[0] as number)
  })

  it('is the lexical ranking alone when nothing is embedded', () => {
    const fused = fuseHybridRelevance([null, null, null], [0.2, 0.9, 0])
    expect(fused[1]).toBeGreaterThan(fused[0] as number)
    expect(fused[2]).toBeNull()
  })

  it('is the dense ranking alone when nothing overlaps lexically', () => {
    const fused = fuseHybridRelevance([0.3, 0.7], [0, 0])
    expect(fused[1]).toBeGreaterThan(fused[0] as number)
  })

  it('returns all-null when neither channel has anything to say', () => {
    // The recall score then falls back to importance + recency — the exact
    // pre-hybrid behaviour, not a fabricated flat relevance.
    expect(fuseHybridRelevance([null, null], [0, 0])).toEqual([null, null])
  })

  it('an unranked candidate scores null, never "ranked last"', () => {
    const fused = fuseHybridRelevance([0.5, null], [0.4, 0])
    expect(fused[0]).not.toBeNull()
    expect(fused[1]).toBeNull()
  })
})
