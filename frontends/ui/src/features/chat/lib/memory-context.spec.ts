/**
 * @vitest-environment node
 */

/**
 * What these hold is the one distinction ADR-0055 turns on: absent memory and
 * memory that carried nothing are DIFFERENT facts, and the second one still has
 * numbers worth stating. Everything else here follows from that.
 */

import { describe, expect, it } from 'vitest'
import type { MemoryContext } from '@/adapters/api/schemas'
import {
  hasMemoryMarker,
  latestMemoryCounts,
  memoryCounts,
  searchedMemory,
} from './memory-context'

const context = (over: Partial<MemoryContext> = {}): MemoryContext => ({
  carried: [{ id: 'm1', kind: 'decision', content: 'Zwei Stiegenhäuser, Ost und West.' }],
  omitted: 44,
  total: 47,
  searched: 0,
  ...over,
})

describe('memoryCounts', () => {
  it('reports carried, total and the omission the wire stated', () => {
    expect(memoryCounts(context())).toEqual({ carried: 1, total: 47, omitted: 44 })
  })

  it('takes `omitted` off the wire rather than recomputing total - carried', () => {
    // The digest's own disclosure to the MODEL is the number the reader must
    // see. Recomputing it here re-opens the divergence this record closes.
    expect(memoryCounts(context({ omitted: 12 }))?.omitted).toBe(12)
  })

  it('is null for a turn with no memory at all — never a zero it invented', () => {
    expect(memoryCounts(undefined)).toBeNull()
  })

  it('still reports the store size when nothing was carried', () => {
    expect(memoryCounts(context({ carried: [], omitted: 47 }))).toEqual({
      carried: 0,
      total: 47,
      omitted: 47,
    })
  })
})

describe('latestMemoryCounts', () => {
  it('takes the newest turn that reported any', () => {
    const messages = [
      { memoryContext: context({ total: 10 }) },
      { memoryContext: context({ total: 47 }) },
    ]
    expect(latestMemoryCounts(messages)?.total).toBe(47)
  })

  it('skips turns that reported none rather than treating them as zero', () => {
    const messages = [{ memoryContext: context({ total: 47 }) }, {}, {}]
    expect(latestMemoryCounts(messages)?.total).toBe(47)
  })

  it('is null for a transcript that never read memory', () => {
    expect(latestMemoryCounts([{}, {}])).toBeNull()
    expect(latestMemoryCounts(undefined)).toBeNull()
  })
})

describe('the marker renders only when something was carried', () => {
  it('is present with notes', () => {
    expect(hasMemoryMarker(context())).toBe(true)
  })

  it('is absent with an empty carry — a line reading "0" under every answer', () => {
    expect(hasMemoryMarker(context({ carried: [] }))).toBe(false)
    expect(hasMemoryMarker(undefined)).toBe(false)
  })
})

describe('reaching past the digest is its own fact', () => {
  it('is false when the tool was never called', () => {
    expect(searchedMemory(context())).toBe(false)
  })

  it('is true the moment search_memory returned anything', () => {
    expect(searchedMemory(context({ searched: 3 }))).toBe(true)
  })
})
