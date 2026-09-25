/**
 * A source is parsed once, not once per mount.
 *
 * A remount of a fence already drawn used to start from `undefined` (the
 * skeleton) and queue another parse behind the mermaid lock.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiagramModel } from './model'

const parseMermaid = vi.fn<(source: string) => Promise<DiagramModel | null>>()
vi.mock('./parse-mermaid', () => ({ parseMermaid: (source: string) => parseMermaid(source) }))

import { clearDiagramModelCache, useDiagramModel } from './use-diagram-model'

const MODEL = { kind: 'flow' } as unknown as DiagramModel

beforeEach(() => {
  clearDiagramModelCache()
  parseMermaid.mockReset()
  parseMermaid.mockResolvedValue(MODEL)
})

describe('useDiagramModel', () => {
  it('answers a remount from the first parse, on its first render', async () => {
    const first = renderHook(() => useDiagramModel('graph TD\n  A --> B'))
    await waitFor(() => expect(first.result.current).toBe(MODEL))
    first.unmount()

    const again = renderHook(() => useDiagramModel('graph TD\n  A --> B'))
    expect(again.result.current).toBe(MODEL)
    expect(parseMermaid).toHaveBeenCalledTimes(1)
  })

  it('shares one parse between two mounts of the same source', async () => {
    const a = renderHook(() => useDiagramModel('graph LR\n  X --> Y'))
    const b = renderHook(() => useDiagramModel('graph LR\n  X --> Y'))
    await waitFor(() => expect(a.result.current).toBe(MODEL))
    await waitFor(() => expect(b.result.current).toBe(MODEL))
    expect(parseMermaid).toHaveBeenCalledTimes(1)
  })

  it('remembers "no view" as an answer too', async () => {
    parseMermaid.mockResolvedValue(null)
    const first = renderHook(() => useDiagramModel('pie\n  "a": 1'))
    await waitFor(() => expect(first.result.current).toBeNull())
    first.unmount()
    const again = renderHook(() => useDiagramModel('pie\n  "a": 1'))
    expect(again.result.current).toBeNull()
    expect(parseMermaid).toHaveBeenCalledTimes(1)
  })

  it('does not parse a fence still being written', () => {
    const { result } = renderHook(() => useDiagramModel('graph TD\n  A -->', false))
    expect(result.current).toBeUndefined()
    expect(parseMermaid).not.toHaveBeenCalled()
  })

  it('keeps the model of a mount made on a cache hit after the cache has evicted it', async () => {
    const first = renderHook(() => useDiagramModel('graph TD\n  Held --> On'))
    await waitFor(() => expect(first.result.current).toBe(MODEL))
    first.unmount()

    // Mounted on a hit, then the page reads 64 other diagrams.
    const held = renderHook(() => useDiagramModel('graph TD\n  Held --> On'))
    expect(held.result.current).toBe(MODEL)
    await readOthers(64)

    held.rerender()
    expect(held.result.current).toBe(MODEL)
  })

  it('evicts the least recently USED source, not the first one parsed', async () => {
    const first = renderHook(() => useDiagramModel('graph TD\n  Often --> Read'))
    await waitFor(() => expect(first.result.current).toBe(MODEL))
    first.unmount()
    await readOthers(63)
    // Read again: now the most recent, so the next parse evicts another.
    renderHook(() => useDiagramModel('graph TD\n  Often --> Read')).unmount()
    await readOthers(1, 63)

    const again = renderHook(() => useDiagramModel('graph TD\n  Often --> Read'))
    expect(again.result.current).toBe(MODEL)
    expect(parseMermaid.mock.calls.filter(([source]) => source.includes('Often'))).toHaveLength(1)
  })
})

/** Mount and settle `count` other sources, as a long page does. */
async function readOthers(count: number, from = 0): Promise<void> {
  for (let i = from; i < from + count; i++) {
    const other = renderHook(() => useDiagramModel(`graph TD\n  N${i} --> M${i}`))
    await waitFor(() => expect(other.result.current).toBe(MODEL))
    other.unmount()
  }
}
