/**
 * The drill-down's slide direction.
 *
 * These exist because the version this replaced was two `useRef`s written
 * during render, and the failure mode of that is not a crash — it is an
 * animation that goes the wrong way, sometimes, which nobody files a bug about.
 * StrictMode is the case that made it always wrong: the second render pass read
 * the value the first pass had just stored, so the direction was 0 on every
 * navigation in development.
 *
 * `renderHook` here runs under the suite's React 18 setup. The point of pinning
 * a double render explicitly is that it is the shape StrictMode produces, and a
 * hook that survives it survives concurrent rendering discarding a pass too.
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLevelDirection } from './use-level-direction'

describe('useLevelDirection', () => {
  it('reports no direction before anything has been navigated', () => {
    // The first paint. A server-rendered listing must not slide in under a
    // reader who has not asked for anything.
    expect(renderHook(() => useLevelDirection(0)).result.current).toBe(0)
    // Including when the page opens INSIDE a folder, from `?folder=` in the
    // URL — the depth is 3 and nothing has moved.
    expect(renderHook(() => useLevelDirection(3)).result.current).toBe(0)
  })

  it('reports deeper as 1 and shallower as -1', () => {
    const { result, rerender } = renderHook(({ depth }) => useLevelDirection(depth), {
      initialProps: { depth: 0 },
    })

    rerender({ depth: 1 })
    expect(result.current).toBe(1)

    rerender({ depth: 2 })
    expect(result.current).toBe(1)

    rerender({ depth: 1 })
    expect(result.current).toBe(-1)

    // Out of a folder three levels deep, straight to the root: still one move,
    // still outward.
    rerender({ depth: 0 })
    expect(result.current).toBe(-1)
  })

  it('keeps the last direction across a re-render that is not a navigation', () => {
    const { result, rerender } = renderHook(({ depth }) => useLevelDirection(depth), {
      initialProps: { depth: 0 },
    })

    rerender({ depth: 1 })
    expect(result.current).toBe(1)

    // A settling poll lands, or a keystroke reaches the search field. The level
    // did not change, so nothing about the transition may.
    rerender({ depth: 1 })
    rerender({ depth: 1 })
    expect(result.current).toBe(1)
  })

  it('survives the same depth being rendered twice, which is what broke it', () => {
    // The ref version stored the new depth on the FIRST pass, so the second
    // compared the new depth against itself and answered 0. Here the state only
    // moves once the render is committed, so a repeated pass is a no-op.
    const { result, rerender } = renderHook(({ depth }) => useLevelDirection(depth), {
      initialProps: { depth: 2 },
    })

    rerender({ depth: 3 })
    rerender({ depth: 3 })
    expect(result.current).toBe(1)
  })
})
